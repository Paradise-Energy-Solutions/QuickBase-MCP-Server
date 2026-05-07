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
import { startRelayServer, RelayClient } from './relay/server.js';
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
  DeleteNotificationSchema,
  ListPipelinesSchema,
  GetPipelineSchema,
  GetPipelineStepSchema,
  GetPipelineActivitySchema,
  FindPipelineUsersSchema,
  GetPipelineYamlSchema,
  GetPipelineTriggerSummarySchema,
  BatchGetPipelineStepsSchema,
  StartImpersonationSchema
} from './tools/index.js';
import { AppConfig, QuickBaseConfig } from './types/quickbase.js';
import { loadAppRegistry, loadDotenv } from './utils/env.js';
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

/** Reusable schema for tools that only require appId (no table/record params). */
const AppIdOnlySchema = z.object({ appId: z.string().min(1).max(64) });

const UpdateFieldArgsSchema = z.object({
  appId: z.string().min(1).max(64),
  confirm: z.literal(true),
  tableId: z.string(),
  fieldId: z.number(),
  label: z.string().optional(),
  required: z.boolean().optional(),
  choices: z.array(z.string()).optional()
});

const DeleteFieldArgsSchema = z.object({
  appId: z.string().min(1).max(64),
  tableId: z.string(),
  fieldId: z.number()
});

const GetRecordArgsSchema = z.object({
  appId: z.string().min(1).max(64),
  tableId: z.string(),
  recordId: z.number(),
  fieldIds: z.array(z.number()).optional()
});

const RunReportArgsSchema = z.object({
  appId: z.string().min(1).max(64),
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

/** Returns a human-readable string describing which user the tool is acting as. */
function viewingAs(impersonateUserId?: string): string {
  return impersonateUserId
    ? `user ${impersonateUserId} (impersonated — your browser session was unaffected)`
    : 'logged-in browser user';
}

class QuickBaseMCPServer {
  private server: Server;
  private baseConfig: Omit<QuickBaseConfig, 'appId'>;
  private appRegistry: Map<string, AppConfig>;
  private clientCache: Map<string, QuickBaseClient>;
  private relayClient: RelayClient | null = null;
  private readonly serverName: string;
  private readonly serverVersion: string;

  constructor() {
    const realm = (process.env.QB_REALM ?? '').trim();
    const userToken = (process.env.QB_USER_TOKEN ?? '').trim();

    if (!realm || !userToken) {
      throw new Error('Missing required environment variables: QB_REALM, QB_USER_TOKEN');
    }

    this.appRegistry = loadAppRegistry();
    if (this.appRegistry.size === 0) {
      throw new Error(
        'No QuickBase apps registered. Add QB_APP_<id>_NAME=<name> entries to your .env file.'
      );
    }

    this.baseConfig = {
      realm,
      userToken,
      timeout: parseEnvInt('QB_DEFAULT_TIMEOUT', 30_000),
      maxRetries: parseEnvInt('QB_MAX_RETRIES', 3)
    };

    this.clientCache = new Map();
    this.serverName = process.env.MCP_SERVER_NAME || 'quickbase-mcp';
    this.serverVersion = process.env.MCP_SERVER_VERSION || '1.0.0';

    const relayPort = parseEnvInt('QB_RELAY_PORT', 3737);
    this.relayClient = startRelayServer(realm, relayPort);

    this.server = new Server(
      { name: this.serverName, version: this.serverVersion },
      { capabilities: { tools: {} } }
    );

    this.setupHandlers();
  }

  /**
   * Returns a cached QuickBaseClient for the given appId.
   * Creates one on first use. Throws McpError for appIds that are not in the
   * registry, preventing unbounded cache growth and giving callers a
   * human-readable error instead of a raw API 404/401.
   */
  private getClientForApp(appId: string): QuickBaseClient {
    if (!this.appRegistry.has(appId)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Unknown appId "${appId}". Call quickbase_list_apps to see registered apps.`
      );
    }
    const cached = this.clientCache.get(appId);
    if (cached) return cached;
    const client = new QuickBaseClient({ ...this.baseConfig, appId });
    if (this.relayClient) client.setRelayClient(this.relayClient);
    this.clientCache.set(appId, client);
    return client;
  }

  /**
   * Returns the read-only and allow-destructive flags for the given appId.
   * Falls back to the strictest safe defaults (readOnly=true, allowDestructive=false)
   * when appId is absent or not found in the registry.
   */
  private getSafetyConfigForApp(appId: string | undefined): { readOnly: boolean; allowDestructive: boolean } {
    if (!appId) return { readOnly: true, allowDestructive: false };
    const app = this.appRegistry.get(appId);
    if (!app) return { readOnly: true, allowDestructive: false };
    return { readOnly: app.readOnly, allowDestructive: app.allowDestructive };
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
        const rawAppId = (args as Record<string, unknown>)?.appId;
        const appId = typeof rawAppId === 'string' ? rawAppId : undefined;
        const safety = this.getSafetyConfigForApp(appId);
        assertToolAllowed({
          name,
          args,
          readOnly: safety.readOnly,
          allowDestructive: safety.allowDestructive
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
    const getClient = (appId: string) => this.getClientForApp(appId);
    return {
      // ========== APP REGISTRY ==========
      quickbase_list_apps: async () =>
        JSON.stringify(Array.from(this.appRegistry.values()), null, 2),

      // ========== APPLICATION ==========
      quickbase_get_app_info: async (args) => {
        const a = parseArgs('quickbase_get_app_info', AppIdOnlySchema, args);
        return JSON.stringify(await getClient(a.appId).getAppInfo(), null, 2);
      },

      quickbase_get_tables: async (args) => {
        const a = parseArgs('quickbase_get_tables', AppIdOnlySchema, args);
        return JSON.stringify(await getClient(a.appId).getAppTables(), null, 2);
      },

      quickbase_test_connection: async (args) => {
        const a = parseArgs('quickbase_test_connection', AppIdOnlySchema, args);
        const ok = await getClient(a.appId).testConnection();
        return `Connection ${ok ? 'successful' : 'failed'}`;
      },

      // ========== TABLES ==========
      quickbase_create_table: async (args) => {
        const a = parseArgs('quickbase_create_table', CreateTableSchema, args);
        const tableId = await getClient(a.appId).createTable({ name: a.name, description: a.description });
        return `Table created with ID: ${tableId}`;
      },

      quickbase_get_table_info: async (args) => {
        const a = parseArgs('quickbase_get_table_info', TableIdSchema, args);
        return JSON.stringify(await getClient(a.appId).getTableInfo(a.tableId), null, 2);
      },

      quickbase_delete_table: async (args) => {
        const a = parseArgs('quickbase_delete_table', TableIdSchema, args);
        await getClient(a.appId).deleteTable(a.tableId);
        return `Table ${a.tableId} deleted successfully`;
      },

      // ========== FIELDS ==========
      quickbase_get_table_fields: async (args) => {
        const a = parseArgs('quickbase_get_table_fields', TableIdSchema, args);
        return JSON.stringify(await getClient(a.appId).getTableFields(a.tableId), null, 2);
      },

      quickbase_create_field: async (args) => {
        const a = parseArgs('quickbase_create_field', CreateFieldSchema, args);
        const fieldId = await getClient(a.appId).createField(a.tableId, {
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
        await getClient(a.appId).updateField(a.tableId, a.fieldId, {
          label: a.label,
          required: a.required,
          choices: a.choices
        });
        return `Field ${a.fieldId} updated successfully`;
      },

      quickbase_delete_field: async (args) => {
        const a = parseArgs('quickbase_delete_field', DeleteFieldArgsSchema, args);
        await getClient(a.appId).deleteField(a.tableId, a.fieldId);
        return `Field ${a.fieldId} deleted successfully`;
      },

      // ========== RECORDS ==========
      quickbase_query_records: async (args) => {
        const a = parseArgs('quickbase_query_records', QueryRecordsSchema, args);
        const records = await getClient(a.appId).getRecords(a.tableId, {
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
        return JSON.stringify(await getClient(a.appId).getRecord(a.tableId, a.recordId, a.fieldIds), null, 2);
      },

      quickbase_create_record: async (args) => {
        const a = parseArgs('quickbase_create_record', CreateRecordSchema, args);
        const newRecordId = await getClient(a.appId).createRecord(a.tableId, {
          fields: a.fields as Record<string, any>
        });
        return newRecordId === null
          ? 'Record created successfully (Record ID not returned by QuickBase API response)'
          : `Record created with ID: ${newRecordId}`;
      },

      quickbase_update_record: async (args) => {
        const a = parseArgs('quickbase_update_record', UpdateRecordSchema, args);
        await getClient(a.appId).updateRecord(a.tableId, a.recordId, a.fields as Record<string, any>);
        return `Record ${a.recordId} updated successfully`;
      },

      quickbase_delete_record: async (args) => {
        const a = parseArgs('quickbase_delete_record', RecordIdSchema, args);
        await getClient(a.appId).deleteRecord(a.tableId, a.recordId);
        return `Record ${a.recordId} deleted successfully`;
      },

      quickbase_bulk_create_records: async (args) => {
        const a = parseArgs('quickbase_bulk_create_records', BulkCreateSchema, args);
        const recordIds = await getClient(a.appId).createRecords(a.tableId, a.records as any[]);
        return recordIds.length === 0
          ? 'Records created successfully (Record IDs not returned by QuickBase API response)'
          : `Created ${recordIds.length} records: ${recordIds.join(', ')}`;
      },

      quickbase_search_records: async (args) => {
        const a = parseArgs('quickbase_search_records', SearchRecordsSchema, args);
        return JSON.stringify(
          await getClient(a.appId).searchRecords(a.tableId, a.searchTerm, a.fieldIds),
          null, 2
        );
      },

      // ========== RELATIONSHIPS ==========
      quickbase_create_relationship: async (args) => {
        const a = parseArgs('quickbase_create_relationship', CreateRelationshipSchema, args);
        await getClient(a.appId).createRelationship(a.parentTableId, a.childTableId, a.foreignKeyFieldId);
        return `Relationship created between ${a.parentTableId} and ${a.childTableId}`;
      },

      quickbase_get_relationships: async (args) => {
        const a = parseArgs('quickbase_get_relationships', TableIdSchema, args);
        return JSON.stringify(await getClient(a.appId).getRelationships(a.tableId), null, 2);
      },

      // ========== REPORTS ==========
      quickbase_get_reports: async (args) => {
        const a = parseArgs('quickbase_get_reports', TableIdSchema, args);
        return JSON.stringify(await getClient(a.appId).getReports(a.tableId), null, 2);
      },

      quickbase_run_report: async (args) => {
        const a = parseArgs('quickbase_run_report', RunReportArgsSchema, args);
        return JSON.stringify(await getClient(a.appId).runReport(a.reportId as string, a.tableId), null, 2);
      },

      // ========== ENHANCED RELATIONSHIPS ==========
      quickbase_create_advanced_relationship: async (args) => {
        const a = parseArgs('quickbase_create_advanced_relationship', CreateAdvancedRelationshipSchema, args);
        return JSON.stringify(
          await getClient(a.appId).createAdvancedRelationship(
            a.parentTableId, a.childTableId, a.referenceFieldLabel,
            a.lookupFields, a.relationshipType as any
          ),
          null, 2
        );
      },

      quickbase_create_lookup_field: async (args) => {
        const a = parseArgs('quickbase_create_lookup_field', CreateLookupFieldSchema, args);
        const lookupFieldId = await getClient(a.appId).createLookupField(
          a.childTableId, a.parentTableId, a.referenceFieldId, a.parentFieldId, a.lookupFieldLabel
        );
        return `Lookup field created with ID: ${lookupFieldId}`;
      },

      quickbase_validate_relationship: async (args) => {
        const a = parseArgs('quickbase_validate_relationship', ValidateRelationshipSchema, args);
        return JSON.stringify(
          await getClient(a.appId).validateRelationship(a.parentTableId, a.childTableId, a.foreignKeyFieldId),
          null, 2
        );
      },

      quickbase_get_relationship_details: async (args) => {
        const a = parseArgs('quickbase_get_relationship_details', GetRelationshipDetailsSchema, args);
        return JSON.stringify(await getClient(a.appId).getRelationshipDetails(a.tableId, a.includeFields), null, 2);
      },

      quickbase_create_junction_table: async (args) => {
        const a = parseArgs('quickbase_create_junction_table', CreateJunctionTableSchema, args);
        return JSON.stringify(
          await getClient(a.appId).createJunctionTable(
            a.junctionTableName, a.table1Id, a.table2Id,
            a.table1FieldLabel, a.table2FieldLabel, a.additionalFields
          ),
          null, 2
        );
      },

      // ========== WEBHOOKS ==========
      quickbase_create_webhook: async (args) => {
        const a = parseArgs('quickbase_create_webhook', CreateWebhookSchema, args);
        const webhookId = await getClient(a.appId).createWebhook(a.tableId, {
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
        const webhooks = await getClient(a.appId).listWebhooks(a.tableId);
        return JSON.stringify({ success: true, tableId: a.tableId, webhooks, count: webhooks.length }, null, 2);
      },

      quickbase_delete_webhook: async (args) => {
        const a = parseArgs('quickbase_delete_webhook', DeleteWebhookSchema, args);
        await getClient(a.appId).deleteWebhook(a.tableId, a.webhookId);
        return JSON.stringify({ success: true, message: `Webhook ${a.webhookId} deleted successfully` }, null, 2);
      },

      quickbase_test_webhook: async (args) => {
        const a = parseArgs('quickbase_test_webhook', TestWebhookSchema, args);
        return JSON.stringify(
          await getClient(a.appId).testWebhook(a.webhookUrl, a.testPayload, a.headers),
          null, 2
        );
      },

      // ========== NOTIFICATIONS ==========
      quickbase_create_notification: async (args) => {
        const a = parseArgs('quickbase_create_notification', CreateNotificationSchema, args);
        const notificationId = await getClient(a.appId).createNotification(a.tableId, {
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
        const notifications = await getClient(a.appId).listNotifications(a.tableId);
        return JSON.stringify({ success: true, tableId: a.tableId, notifications, count: notifications.length }, null, 2);
      },

      quickbase_delete_notification: async (args) => {
        const a = parseArgs('quickbase_delete_notification', DeleteNotificationSchema, args);
        await getClient(a.appId).deleteNotification(a.tableId, a.notificationId);
        return JSON.stringify({ success: true, message: `Notification ${a.notificationId} deleted successfully` }, null, 2);
      },

      // ========== PIPELINES (Unofficial API) ==========

      quickbase_list_pipelines: async (args) => {
        const a = parseArgs('quickbase_list_pipelines', ListPipelinesSchema, args);
        const result = await getClient(a.appId).listPipelines({
          pageNumber: a.pageNumber,
          pageSize: a.pageSize,
          realmWide: a.realmWide,
          channels: a.channels,
          tags: a.tags,
          impersonateUserId: a.impersonateUserId,
          filterByTableId: a.filterByTableId
        });
        const annotated = {
          _viewingAs: viewingAs(a.impersonateUserId),
          ...result
        };
        return JSON.stringify(annotated, null, 2);
      },

      quickbase_get_pipeline: async (args) => {
        const a = parseArgs('quickbase_get_pipeline', GetPipelineSchema, args);
        const result = await getClient(a.appId).getPipelineDetail(a.pipelineId, a.impersonateUserId);
        return JSON.stringify(
          {
            _viewingAs: viewingAs(a.impersonateUserId),
            ...result
          },
          null, 2
        );
      },

      quickbase_get_pipeline_step: async (args) => {
        const a = parseArgs('quickbase_get_pipeline_step', GetPipelineStepSchema, args);
        const result = await getClient(a.appId).getPipelineStepConfig(a.pipelineId, a.stepId, a.impersonateUserId);
        return JSON.stringify(
          {
            _viewingAs: viewingAs(a.impersonateUserId),
            ...result
          },
          null, 2
        );
      },

      quickbase_get_pipeline_yaml: async (args) => {
        const a = parseArgs('quickbase_get_pipeline_yaml', GetPipelineYamlSchema, args);
        const yaml = await getClient(a.appId).getPipelineYaml(a.pipelineId, a.impersonateUserId);
        return yaml;
      },

      quickbase_get_pipeline_activity: async (args) => {
        const a = parseArgs('quickbase_get_pipeline_activity', GetPipelineActivitySchema, args);
        const result = await getClient(a.appId).getPipelineActivity(a.pipelineId, {
          startDate: a.startDate,
          endDate: a.endDate,
          perPage: a.perPage,
          impersonateUserId: a.impersonateUserId,
          recordId: a.recordId
        });
        return JSON.stringify(
          {
            _viewingAs: viewingAs(a.impersonateUserId),
            ...result
          },
          null, 2
        );
      },

      quickbase_get_pipeline_trigger_summary: async (args) => {
        const a = parseArgs('quickbase_get_pipeline_trigger_summary', GetPipelineTriggerSummarySchema, args);
        const result = await getClient(a.appId).getPipelineTriggerSummary(a.pipelineId, a.impersonateUserId);
        return JSON.stringify(
          {
            _viewingAs: viewingAs(a.impersonateUserId),
            ...result
          },
          null, 2
        );
      },

      quickbase_batch_get_pipeline_steps: async (args) => {
        const a = parseArgs('quickbase_batch_get_pipeline_steps', BatchGetPipelineStepsSchema, args);
        const results = await getClient(a.appId).batchGetPipelineSteps(a.steps, a.impersonateUserId);
        return JSON.stringify(
          {
            _viewingAs: viewingAs(a.impersonateUserId),
            steps: results
          },
          null, 2
        );
      },

      quickbase_find_pipeline_users: async (args) => {
        const a = parseArgs('quickbase_find_pipeline_users', FindPipelineUsersSchema, args);
        return JSON.stringify(await getClient(a.appId).findPipelineUsers(a.query), null, 2);
      },

      quickbase_start_impersonation: async (args) => {
        const a = parseArgs('quickbase_start_impersonation', StartImpersonationSchema, args);
        return JSON.stringify(
          await getClient(a.appId).startPipelineImpersonation(a.qbUserId),
          null, 2
        );
      },

      quickbase_end_impersonation: async (args) => {
        const a = parseArgs('quickbase_end_impersonation', z.object({ appId: z.string().min(1).max(64) }), args);
        return JSON.stringify(await getClient(a.appId).endPipelineImpersonation(), null, 2);
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