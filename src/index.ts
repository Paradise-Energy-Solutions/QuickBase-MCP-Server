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
import { assertToolAllowed } from './utils/toolGuards.js';
import { z } from 'zod';

function formatErrorForLog(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return typeof error === 'string' ? error : JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}

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

class QuickBaseMCPServer {
  private server: Server;
  private qbClient: QuickBaseClient;
  private allowDestructive: boolean;
  private readOnly: boolean;

  constructor() {
    // Validate environment variables
    const config: QuickBaseConfig = {
      realm: process.env.QB_REALM || '',
      userToken: process.env.QB_USER_TOKEN || '',
      appId: process.env.QB_APP_ID || '',
      timeout: parseInt(process.env.QB_DEFAULT_TIMEOUT || '30000'),
      maxRetries: parseInt(process.env.QB_MAX_RETRIES || '3')
    };

    if (!config.realm || !config.userToken || !config.appId) {
      throw new Error('Missing required environment variables: QB_REALM, QB_USER_TOKEN, QB_APP_ID');
    }

    this.allowDestructive = envFlag('QB_ALLOW_DESTRUCTIVE', false);
    this.readOnly = envFlag('QB_READONLY', false);

    this.qbClient = new QuickBaseClient(config);
    this.server = new Server(
      {
        name: process.env.MCP_SERVER_NAME || 'quickbase-mcp',
        version: process.env.MCP_SERVER_VERSION || '1.0.0',
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
    // Initialize the server and declare capabilities
    this.server.setRequestHandler(InitializeRequestSchema, async () => {
      return {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: process.env.MCP_SERVER_NAME || 'quickbase-mcp',
          version: process.env.MCP_SERVER_VERSION || '1.0.0',
        },
      };
    });

    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: quickbaseTools,
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      const { name, arguments: args } = request.params;

      try {
        assertToolAllowed({
          name,
          args,
          readOnly: this.readOnly,
          allowDestructive: this.allowDestructive
        });

        switch (name) {
          // ========== APPLICATION TOOLS ==========
          case 'quickbase_get_app_info':
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(await this.qbClient.getAppInfo(), null, 2),
                },
              ],
            };

          case 'quickbase_get_tables':
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(await this.qbClient.getAppTables(), null, 2),
                },
              ],
            };

          case 'quickbase_test_connection':
            const isConnected = await this.qbClient.testConnection();
            return {
              content: [
                {
                  type: 'text',
                  text: `Connection ${isConnected ? 'successful' : 'failed'}`,
                },
              ],
            };

          // ========== TABLE TOOLS ==========
          case 'quickbase_create_table':
            const createTableArgs = parseArgs('quickbase_create_table', CreateTableSchema, args);
            const tableId = await this.qbClient.createTable({
              name: createTableArgs.name,
              description: createTableArgs.description
            });
            return {
              content: [
                {
                  type: 'text',
                  text: `Table created with ID: ${tableId}`,
                },
              ],
            };

          case 'quickbase_get_table_info':
            const tableIdArgs = parseArgs('quickbase_get_table_info', TableIdSchema, args);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(await this.qbClient.getTableInfo(tableIdArgs.tableId), null, 2),
                },
              ],
            };

          case 'quickbase_delete_table':
            const deleteTableArgs = parseArgs('quickbase_delete_table', TableIdSchema, args);
            await this.qbClient.deleteTable(deleteTableArgs.tableId);
            return {
              content: [
                {
                  type: 'text',
                  text: `Table ${deleteTableArgs.tableId} deleted successfully`,
                },
              ],
            };

          // ========== FIELD TOOLS ==========
          case 'quickbase_get_table_fields':
            const getFieldsArgs = parseArgs('quickbase_get_table_fields', TableIdSchema, args);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(await this.qbClient.getTableFields(getFieldsArgs.tableId), null, 2),
                },
              ],
            };

          case 'quickbase_create_field':
            const createFieldArgs = parseArgs('quickbase_create_field', CreateFieldSchema, args);
            const fieldId = await this.qbClient.createField(createFieldArgs.tableId, {
              label: createFieldArgs.label,
              fieldType: createFieldArgs.fieldType as any,
              required: createFieldArgs.required,
              unique: createFieldArgs.unique,
              choices: createFieldArgs.choices,
              formula: createFieldArgs.formula,
              lookupReference: createFieldArgs.lookupTableId ? {
                tableId: createFieldArgs.lookupTableId,
                fieldId: createFieldArgs.lookupFieldId as number
              } : undefined
            });
            return {
              content: [
                {
                  type: 'text',
                  text: `Field created with ID: ${fieldId}`,
                },
              ],
            };

          case 'quickbase_update_field':
            const updateFieldArgs = parseArgs('quickbase_update_field', UpdateFieldArgsSchema, args);
            await this.qbClient.updateField(updateFieldArgs.tableId, updateFieldArgs.fieldId, {
              label: updateFieldArgs.label,
              required: updateFieldArgs.required,
              choices: updateFieldArgs.choices
            });
            return {
              content: [
                {
                  type: 'text',
                  text: `Field ${updateFieldArgs.fieldId} updated successfully`,
                },
              ],
            };

          case 'quickbase_delete_field':
            const deleteFieldArgs = parseArgs('quickbase_delete_field', DeleteFieldArgsSchema, args);
            await this.qbClient.deleteField(deleteFieldArgs.tableId, deleteFieldArgs.fieldId);
            return {
              content: [
                {
                  type: 'text',
                  text: `Field ${deleteFieldArgs.fieldId} deleted successfully`,
                },
              ],
            };

          // ========== RECORD TOOLS ==========
          case 'quickbase_query_records':
            const queryArgs = parseArgs('quickbase_query_records', QueryRecordsSchema, args);
            const records = await this.qbClient.getRecords(queryArgs.tableId, {
              select: queryArgs.select,
              where: queryArgs.where,
              sortBy: queryArgs.sortBy as any[],
              top: queryArgs.top,
              skip: queryArgs.skip
            });
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(records, null, 2),
                },
              ],
            };

          case 'quickbase_get_record':
            const getRecordArgs = parseArgs('quickbase_get_record', GetRecordArgsSchema, args);
            const record = await this.qbClient.getRecord(getRecordArgs.tableId, getRecordArgs.recordId, getRecordArgs.fieldIds);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(record, null, 2),
                },
              ],
            };

          case 'quickbase_create_record':
            const createRecordArgs = parseArgs('quickbase_create_record', CreateRecordSchema, args);
            const newRecordId = await this.qbClient.createRecord(createRecordArgs.tableId, {
              fields: createRecordArgs.fields as Record<string, any>
            });
            return {
              content: [
                {
                  type: 'text',
                  text: newRecordId === null
                    ? 'Record created successfully (Record ID not returned by QuickBase API response)'
                    : `Record created with ID: ${newRecordId}`,
                },
              ],
            };

          case 'quickbase_update_record':
            const updateRecordArgs = parseArgs('quickbase_update_record', UpdateRecordSchema, args);
            await this.qbClient.updateRecord(updateRecordArgs.tableId, updateRecordArgs.recordId, updateRecordArgs.fields as Record<string, any>);
            return {
              content: [
                {
                  type: 'text',
                  text: `Record ${updateRecordArgs.recordId} updated successfully`,
                },
              ],
            };

          case 'quickbase_delete_record':
            const deleteRecordArgs = parseArgs('quickbase_delete_record', RecordIdSchema, args);
            await this.qbClient.deleteRecord(deleteRecordArgs.tableId, deleteRecordArgs.recordId);
            return {
              content: [
                {
                  type: 'text',
                  text: `Record ${deleteRecordArgs.recordId} deleted successfully`,
                },
              ],
            };

          case 'quickbase_bulk_create_records':
            const bulkCreateArgs = parseArgs('quickbase_bulk_create_records', BulkCreateSchema, args);
            const recordIds = await this.qbClient.createRecords(
              bulkCreateArgs.tableId,
              bulkCreateArgs.records as any[]
            );
            return {
              content: [
                {
                  type: 'text',
                  text: recordIds.length === 0
                    ? 'Records created successfully (Record IDs not returned by QuickBase API response)'
                    : `Created ${recordIds.length} records: ${recordIds.join(', ')}`,
                },
              ],
            };

          case 'quickbase_search_records':
            const searchArgs = parseArgs('quickbase_search_records', SearchRecordsSchema, args);
            const searchResults = await this.qbClient.searchRecords(
              searchArgs.tableId,
              searchArgs.searchTerm,
              searchArgs.fieldIds
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(searchResults, null, 2),
                },
              ],
            };

          // ========== RELATIONSHIP TOOLS ==========
          case 'quickbase_create_relationship':
            const createRelationshipArgs = parseArgs('quickbase_create_relationship', CreateRelationshipSchema, args);
            await this.qbClient.createRelationship(
              createRelationshipArgs.parentTableId,
              createRelationshipArgs.childTableId,
              createRelationshipArgs.foreignKeyFieldId
            );
            return {
              content: [
                {
                  type: 'text',
                  text: `Relationship created between ${createRelationshipArgs.parentTableId} and ${createRelationshipArgs.childTableId}`,
                },
              ],
            };

          case 'quickbase_get_relationships':
            const relationshipsArgs = parseArgs('quickbase_get_relationships', TableIdSchema, args);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(await this.qbClient.getRelationships(relationshipsArgs.tableId), null, 2),
                },
              ],
            };

          // ========== UTILITY TOOLS ==========
          case 'quickbase_get_reports':
            const reportsArgs = parseArgs('quickbase_get_reports', TableIdSchema, args);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(await this.qbClient.getReports(reportsArgs.tableId), null, 2),
                },
              ],
            };

          case 'quickbase_run_report':
            const runReportArgs = parseArgs('quickbase_run_report', RunReportArgsSchema, args);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    await this.qbClient.runReport(runReportArgs.reportId as string, runReportArgs.tableId), 
                    null, 
                    2
                  ),
                },
              ],
            };

          // ========== ENHANCED RELATIONSHIP TOOLS ==========
          case 'quickbase_create_advanced_relationship':
            const advRelArgs = parseArgs('quickbase_create_advanced_relationship', CreateAdvancedRelationshipSchema, args);
            const advResult = await this.qbClient.createAdvancedRelationship(
              advRelArgs.parentTableId,
              advRelArgs.childTableId,
              advRelArgs.referenceFieldLabel,
              advRelArgs.lookupFields,
              advRelArgs.relationshipType as any
            );
            return {
              content: [{ type: 'text', text: JSON.stringify(advResult, null, 2) }]
            };

          case 'quickbase_create_lookup_field':
            const lookupArgs = parseArgs('quickbase_create_lookup_field', CreateLookupFieldSchema, args);
            const lookupFieldId = await this.qbClient.createLookupField(
              lookupArgs.childTableId,
              lookupArgs.parentTableId,
              lookupArgs.referenceFieldId,
              lookupArgs.parentFieldId,
              lookupArgs.lookupFieldLabel
            );
            return {
              content: [{ type: 'text', text: `Lookup field created with ID: ${lookupFieldId}` }]
            };

          case 'quickbase_validate_relationship':
            const validateArgs = parseArgs('quickbase_validate_relationship', ValidateRelationshipSchema, args);
            const validationResult = await this.qbClient.validateRelationship(
              validateArgs.parentTableId,
              validateArgs.childTableId,
              validateArgs.foreignKeyFieldId
            );
            return {
              content: [{ type: 'text', text: JSON.stringify(validationResult, null, 2) }]
            };

          case 'quickbase_get_relationship_details':
            const detailsArgs = parseArgs('quickbase_get_relationship_details', GetRelationshipDetailsSchema, args);
            const detailsResult = await this.qbClient.getRelationshipDetails(
              detailsArgs.tableId,
              detailsArgs.includeFields
            );
            return {
              content: [{ type: 'text', text: JSON.stringify(detailsResult, null, 2) }]
            };

          case 'quickbase_create_junction_table':
            const junctionArgs = parseArgs('quickbase_create_junction_table', CreateJunctionTableSchema, args);
            const junctionResult = await this.qbClient.createJunctionTable(
              junctionArgs.junctionTableName,
              junctionArgs.table1Id,
              junctionArgs.table2Id,
              junctionArgs.table1FieldLabel,
              junctionArgs.table2FieldLabel,
              junctionArgs.additionalFields
            );
            return {
              content: [{ type: 'text', text: JSON.stringify(junctionResult, null, 2) }]
            };

          // ========== WEBHOOK TOOLS ==========
          case 'quickbase_create_webhook':
            const createWebhookArgs = parseArgs('quickbase_create_webhook', CreateWebhookSchema, args);
            const webhookId = await this.qbClient.createWebhook(
              createWebhookArgs.tableId,
              {
                label: createWebhookArgs.label,
                description: createWebhookArgs.description,
                webhookUrl: createWebhookArgs.webhookUrl,
                webhookEvents: createWebhookArgs.webhookEvents,
                messageFormat: createWebhookArgs.messageFormat,
                messageBody: createWebhookArgs.messageBody,
                webhookHeaders: createWebhookArgs.webhookHeaders,
                httpMethod: createWebhookArgs.httpMethod,
                triggerFields: createWebhookArgs.triggerFields
              }
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    webhookId,
                    message: `Webhook "${createWebhookArgs.label}" created successfully`
                  }, null, 2)
                }
              ]
            };

          case 'quickbase_list_webhooks':
            const listWebhooksArgs = parseArgs('quickbase_list_webhooks', ListWebhooksSchema, args);
            const webhooks = await this.qbClient.listWebhooks(listWebhooksArgs.tableId);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    tableId: listWebhooksArgs.tableId,
                    webhooks,
                    count: webhooks.length
                  }, null, 2)
                }
              ]
            };

          case 'quickbase_delete_webhook':
            const deleteWebhookArgs = parseArgs('quickbase_delete_webhook', DeleteWebhookSchema, args);
            await this.qbClient.deleteWebhook(deleteWebhookArgs.tableId, deleteWebhookArgs.webhookId);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    message: `Webhook ${deleteWebhookArgs.webhookId} deleted successfully`
                  }, null, 2)
                }
              ]
            };

          case 'quickbase_test_webhook':
            const testWebhookArgs = parseArgs('quickbase_test_webhook', TestWebhookSchema, args);
            const testResult = await this.qbClient.testWebhook(
              testWebhookArgs.webhookUrl,
              testWebhookArgs.testPayload,
              testWebhookArgs.headers
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(testResult, null, 2)
                }
              ]
            };

          // ========== NOTIFICATION TOOLS ==========
          case 'quickbase_create_notification':
            const createNotifArgs = parseArgs('quickbase_create_notification', CreateNotificationSchema, args);
            const notificationId = await this.qbClient.createNotification(
              createNotifArgs.tableId,
              {
                label: createNotifArgs.label,
                description: createNotifArgs.description,
                notificationEvent: createNotifArgs.notificationEvent,
                recipientEmail: createNotifArgs.recipientEmail,
                messageSubject: createNotifArgs.messageSubject,
                messageBody: createNotifArgs.messageBody,
                includeAllFields: createNotifArgs.includeAllFields,
                triggerFields: createNotifArgs.triggerFields
              }
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    notificationId,
                    message: `Notification "${createNotifArgs.label}" created successfully`
                  }, null, 2)
                }
              ]
            };

          case 'quickbase_list_notifications':
            const listNotifArgs = parseArgs('quickbase_list_notifications', ListNotificationsSchema, args);
            const notifications = await this.qbClient.listNotifications(listNotifArgs.tableId);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    tableId: listNotifArgs.tableId,
                    notifications,
                    count: notifications.length
                  }, null, 2)
                }
              ]
            };

          case 'quickbase_delete_notification':
            const deleteNotifArgs = parseArgs('quickbase_delete_notification', DeleteNotificationSchema, args);
            await this.qbClient.deleteNotification(deleteNotifArgs.tableId, deleteNotifArgs.notificationId);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    message: `Notification ${deleteNotifArgs.notificationId} deleted successfully`
                  }, null, 2)
                }
              ]
            };

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Error executing tool ${name}: ${formatErrorForLog(error)}`);
        
        throw new McpError(
          ErrorCode.InternalError,
          `Error executing ${name}: ${errorMessage}`
        );
      }
    });
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