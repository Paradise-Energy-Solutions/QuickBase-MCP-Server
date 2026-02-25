#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { QuickBaseClient } from './quickbase/client.js';
import {
  quickbaseTools,
  TableIdSchema,
  RecordIdSchema,
  CreateTableSchema,
  CreateFieldSchema,
  QueryRecordsSchema,
  CreateRecordSchema,
  UpdateRecordSchema,
  BulkCreateSchema,
  SearchRecordsSchema,
  CreateRelationshipSchema,
  CreateAdvancedRelationshipSchema,
  CreateLookupFieldSchema,
  ValidateRelationshipSchema,
  CreateJunctionTableSchema,
  GetRelationshipDetailsSchema,
  CreateWebhookSchema,
  ListWebhooksSchema,
  DeleteWebhookSchema,
  TestWebhookSchema,
  CreateNotificationSchema,
  ListNotificationsSchema,
  DeleteNotificationSchema
} from './tools/index.js';
import { QuickBaseConfig } from './types/quickbase.js';
import { envFlag, loadDotenv } from './utils/env.js';
import { formatErrorForLog } from './utils/errors.js';
import { assertToolAllowed } from './utils/toolGuards.js';
import { z } from 'zod';

function parseArgs<T>(toolName: string, schema: { parse: (input: unknown) => T }, args: unknown): T {
  try {
    return schema.parse(args ?? {});
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid arguments';
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Invalid arguments for ${toolName}: ${message}`
    );
  }
}

const UpdateFieldArgsSchema = z.object({
  confirm: z.literal(true),
  tableId: z.string(),
  fieldId: z.number(),
  label: z.string().optional(),
  required: z.boolean().optional(),
  choices: z.array(z.string()).optional()
});

const DeleteFieldArgsSchema = z.object({
  tableId: z.string(),
  fieldId: z.number()
});

const GetRecordArgsSchema = z.object({
  tableId: z.string(),
  recordId: z.number(),
  fieldIds: z.array(z.number()).optional()
});

const RunReportArgsSchema = z.object({
  tableId: z.string(),
  reportId: z.string()
});

// Load environment variables
loadDotenv(import.meta.url);

/**
 * Parse an environment variable as a positive integer.
 * Falls back to `defaultValue` when the variable is absent, non-numeric, or non-positive.
 */
function parseEnvInt(name: string, defaultValue: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : defaultValue;
}

class QuickBaseMCPServer {
  private server: Server;
  private qbClient: QuickBaseClient;
  private allowDestructive: boolean;
  private readOnly: boolean;
  private readonly serverName: string;
  private readonly serverVersion: string;

  constructor() {
    // Validate environment variables
    const config: QuickBaseConfig = {
      realm: (process.env.QB_REALM ?? '').trim(),
      userToken: (process.env.QB_USER_TOKEN ?? '').trim(),
      appId: (process.env.QB_APP_ID ?? '').trim(),
      timeout: parseEnvInt('QB_DEFAULT_TIMEOUT', 30_000),
      maxRetries: parseEnvInt('QB_MAX_RETRIES', 3)
    };

    if (!config.realm || !config.userToken || !config.appId) {
      throw new Error('Missing required environment variables: QB_REALM, QB_USER_TOKEN, QB_APP_ID');
    }

    this.allowDestructive = envFlag('QB_ALLOW_DESTRUCTIVE', false);
    this.readOnly = envFlag('QB_READONLY', false);
    this.serverName = process.env.MCP_SERVER_NAME || 'quickbase-mcp';
    this.serverVersion = process.env.MCP_SERVER_VERSION || '1.0.0';

    this.qbClient = new QuickBaseClient(config);
    this.server = new Server(
      {
        name: this.serverName,
        version: this.serverVersion,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(InitializeRequestSchema, async () => ({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: this.serverName, version: this.serverVersion },
    }));

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: quickbaseTools,
    }));

    const toolHandlers = this.buildToolHandlers();

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        assertToolAllowed({
          name,
          args,
          readOnly: this.readOnly,
          allowDestructive: this.allowDestructive
        });

        const handler = toolHandlers[name];
        if (!handler) {
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }

        return { content: [{ type: 'text' as const, text: await handler(args) }] };
      } catch (error) {
        // Preserve the original error code for McpErrors (e.g. InvalidRequest from assertToolAllowed).
        if (error instanceof McpError) throw error;

        console.error(`Error executing tool ${name}: ${formatErrorForLog(error)}`);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(
          ErrorCode.InternalError,
          `Error executing ${name}: ${errorMessage}`
        );
      }
    });
  }

  /** Build a map of tool name → handler function. Each handler receives raw args and returns a text string. */
  private buildToolHandlers(): Record<string, (args: unknown) => Promise<string>> {
    const qb = this.qbClient;
    return {
      // ========== APPLICATION ==========
      quickbase_get_app_info: async () =>
        JSON.stringify(await qb.getAppInfo(), null, 2),

      quickbase_get_tables: async () =>
        JSON.stringify(await qb.getAppTables(), null, 2),

      quickbase_test_connection: async () => {
        const ok = await qb.testConnection();
        return `Connection ${ok ? 'successful' : 'failed'}`;
      },

      // ========== TABLES ==========
      quickbase_create_table: async (args) => {
        const a = parseArgs('quickbase_create_table', CreateTableSchema, args);
        const tableId = await qb.createTable({ name: a.name, description: a.description });
        return `Table created with ID: ${tableId}`;
      },

      quickbase_get_table_info: async (args) => {
        const a = parseArgs('quickbase_get_table_info', TableIdSchema, args);
        return JSON.stringify(await qb.getTableInfo(a.tableId), null, 2);
      },

      quickbase_delete_table: async (args) => {
        const a = parseArgs('quickbase_delete_table', TableIdSchema, args);
        await qb.deleteTable(a.tableId);
        return `Table ${a.tableId} deleted successfully`;
      },

      // ========== FIELDS ==========
      quickbase_get_table_fields: async (args) => {
        const a = parseArgs('quickbase_get_table_fields', TableIdSchema, args);
        return JSON.stringify(await qb.getTableFields(a.tableId), null, 2);
      },

      quickbase_create_field: async (args) => {
        const a = parseArgs('quickbase_create_field', CreateFieldSchema, args);
        const fieldId = await qb.createField(a.tableId, {
          label: a.label,
          fieldType: a.fieldType as any,
          required: a.required,
          unique: a.unique,
          choices: a.choices,
          formula: a.formula,
          lookupReference: a.lookupTableId
            ? { tableId: a.lookupTableId, fieldId: a.lookupFieldId as number }
            : undefined
        });
        return `Field created with ID: ${fieldId}`;
      },

      quickbase_update_field: async (args) => {
        const a = parseArgs('quickbase_update_field', UpdateFieldArgsSchema, args);
        await qb.updateField(a.tableId, a.fieldId, {
          label: a.label,
          required: a.required,
          choices: a.choices
        });
        return `Field ${a.fieldId} updated successfully`;
      },

      quickbase_delete_field: async (args) => {
        const a = parseArgs('quickbase_delete_field', DeleteFieldArgsSchema, args);
        await qb.deleteField(a.tableId, a.fieldId);
        return `Field ${a.fieldId} deleted successfully`;
      },

      // ========== RECORDS ==========
      quickbase_query_records: async (args) => {
        const a = parseArgs('quickbase_query_records', QueryRecordsSchema, args);
        const records = await qb.getRecords(a.tableId, {
          select: a.select,
          where: a.where,
          sortBy: a.sortBy as any[],
          top: a.top,
          skip: a.skip
        });
        return JSON.stringify(records, null, 2);
      },

      quickbase_get_record: async (args) => {
        const a = parseArgs('quickbase_get_record', GetRecordArgsSchema, args);
        return JSON.stringify(await qb.getRecord(a.tableId, a.recordId, a.fieldIds), null, 2);
      },

      quickbase_create_record: async (args) => {
        const a = parseArgs('quickbase_create_record', CreateRecordSchema, args);
        const newRecordId = await qb.createRecord(a.tableId, {
          fields: a.fields as Record<string, any>
        });
        return newRecordId === null
          ? 'Record created successfully (Record ID not returned by QuickBase API response)'
          : `Record created with ID: ${newRecordId}`;
      },

      quickbase_update_record: async (args) => {
        const a = parseArgs('quickbase_update_record', UpdateRecordSchema, args);
        await qb.updateRecord(a.tableId, a.recordId, a.fields as Record<string, any>);
        return `Record ${a.recordId} updated successfully`;
      },

      quickbase_delete_record: async (args) => {
        const a = parseArgs('quickbase_delete_record', RecordIdSchema, args);
        await qb.deleteRecord(a.tableId, a.recordId);
        return `Record ${a.recordId} deleted successfully`;
      },

      quickbase_bulk_create_records: async (args) => {
        const a = parseArgs('quickbase_bulk_create_records', BulkCreateSchema, args);
        const recordIds = await qb.createRecords(a.tableId, a.records as any[]);
        return recordIds.length === 0
          ? 'Records created successfully (Record IDs not returned by QuickBase API response)'
          : `Created ${recordIds.length} records: ${recordIds.join(', ')}`;
      },

      quickbase_search_records: async (args) => {
        const a = parseArgs('quickbase_search_records', SearchRecordsSchema, args);
        return JSON.stringify(
          await qb.searchRecords(a.tableId, a.searchTerm, a.fieldIds),
          null, 2
        );
      },

      // ========== RELATIONSHIPS ==========
      quickbase_create_relationship: async (args) => {
        const a = parseArgs('quickbase_create_relationship', CreateRelationshipSchema, args);
        await qb.createRelationship(a.parentTableId, a.childTableId, a.foreignKeyFieldId);
        return `Relationship created between ${a.parentTableId} and ${a.childTableId}`;
      },

      quickbase_get_relationships: async (args) => {
        const a = parseArgs('quickbase_get_relationships', TableIdSchema, args);
        return JSON.stringify(await qb.getRelationships(a.tableId), null, 2);
      },

      // ========== REPORTS ==========
      quickbase_get_reports: async (args) => {
        const a = parseArgs('quickbase_get_reports', TableIdSchema, args);
        return JSON.stringify(await qb.getReports(a.tableId), null, 2);
      },

      quickbase_run_report: async (args) => {
        const a = parseArgs('quickbase_run_report', RunReportArgsSchema, args);
        return JSON.stringify(await qb.runReport(a.reportId as string, a.tableId), null, 2);
      },

      // ========== ENHANCED RELATIONSHIPS ==========
      quickbase_create_advanced_relationship: async (args) => {
        const a = parseArgs('quickbase_create_advanced_relationship', CreateAdvancedRelationshipSchema, args);
        return JSON.stringify(
          await qb.createAdvancedRelationship(
            a.parentTableId, a.childTableId, a.referenceFieldLabel,
            a.lookupFields, a.relationshipType as any
          ),
          null, 2
        );
      },

      quickbase_create_lookup_field: async (args) => {
        const a = parseArgs('quickbase_create_lookup_field', CreateLookupFieldSchema, args);
        const lookupFieldId = await qb.createLookupField(
          a.childTableId, a.parentTableId, a.referenceFieldId, a.parentFieldId, a.lookupFieldLabel
        );
        return `Lookup field created with ID: ${lookupFieldId}`;
      },

      quickbase_validate_relationship: async (args) => {
        const a = parseArgs('quickbase_validate_relationship', ValidateRelationshipSchema, args);
        return JSON.stringify(
          await qb.validateRelationship(a.parentTableId, a.childTableId, a.foreignKeyFieldId),
          null, 2
        );
      },

      quickbase_get_relationship_details: async (args) => {
        const a = parseArgs('quickbase_get_relationship_details', GetRelationshipDetailsSchema, args);
        return JSON.stringify(await qb.getRelationshipDetails(a.tableId, a.includeFields), null, 2);
      },

      quickbase_create_junction_table: async (args) => {
        const a = parseArgs('quickbase_create_junction_table', CreateJunctionTableSchema, args);
        return JSON.stringify(
          await qb.createJunctionTable(
            a.junctionTableName, a.table1Id, a.table2Id,
            a.table1FieldLabel, a.table2FieldLabel, a.additionalFields
          ),
          null, 2
        );
      },

      // ========== WEBHOOKS ==========
      quickbase_create_webhook: async (args) => {
        const a = parseArgs('quickbase_create_webhook', CreateWebhookSchema, args);
        const webhookId = await qb.createWebhook(a.tableId, {
          label: a.label,
          description: a.description,
          webhookUrl: a.webhookUrl,
          webhookEvents: a.webhookEvents,
          messageFormat: a.messageFormat,
          messageBody: a.messageBody,
          webhookHeaders: a.webhookHeaders,
          httpMethod: a.httpMethod,
          triggerFields: a.triggerFields
        });
        return JSON.stringify({
          success: true, webhookId,
          message: `Webhook "${a.label}" created successfully`
        }, null, 2);
      },

      quickbase_list_webhooks: async (args) => {
        const a = parseArgs('quickbase_list_webhooks', ListWebhooksSchema, args);
        const webhooks = await qb.listWebhooks(a.tableId);
        return JSON.stringify({ success: true, tableId: a.tableId, webhooks, count: webhooks.length }, null, 2);
      },

      quickbase_delete_webhook: async (args) => {
        const a = parseArgs('quickbase_delete_webhook', DeleteWebhookSchema, args);
        await qb.deleteWebhook(a.tableId, a.webhookId);
        return JSON.stringify({ success: true, message: `Webhook ${a.webhookId} deleted successfully` }, null, 2);
      },

      quickbase_test_webhook: async (args) => {
        const a = parseArgs('quickbase_test_webhook', TestWebhookSchema, args);
        return JSON.stringify(
          await qb.testWebhook(a.webhookUrl, a.testPayload, a.headers),
          null, 2
        );
      },

      // ========== NOTIFICATIONS ==========
      quickbase_create_notification: async (args) => {
        const a = parseArgs('quickbase_create_notification', CreateNotificationSchema, args);
        const notificationId = await qb.createNotification(a.tableId, {
          label: a.label,
          description: a.description,
          notificationEvent: a.notificationEvent,
          recipientEmail: a.recipientEmail,
          messageSubject: a.messageSubject,
          messageBody: a.messageBody,
          includeAllFields: a.includeAllFields,
          triggerFields: a.triggerFields
        });
        return JSON.stringify({
          success: true, notificationId,
          message: `Notification "${a.label}" created successfully`
        }, null, 2);
      },

      quickbase_list_notifications: async (args) => {
        const a = parseArgs('quickbase_list_notifications', ListNotificationsSchema, args);
        const notifications = await qb.listNotifications(a.tableId);
        return JSON.stringify({ success: true, tableId: a.tableId, notifications, count: notifications.length }, null, 2);
      },

      quickbase_delete_notification: async (args) => {
        const a = parseArgs('quickbase_delete_notification', DeleteNotificationSchema, args);
        await qb.deleteNotification(a.tableId, a.notificationId);
        return JSON.stringify({ success: true, message: `Notification ${a.notificationId} deleted successfully` }, null, 2);
      },
    };
  }


  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('QuickBase MCP server running on stdio');
  }
}

// Start the server
async function main() {
  try {
    const server = new QuickBaseMCPServer();
    await server.run();
  } catch (error) {
    console.error(`Failed to start server: ${formatErrorForLog(error)}`);
    process.exit(1);
  }
}

main().catch(console.error); 