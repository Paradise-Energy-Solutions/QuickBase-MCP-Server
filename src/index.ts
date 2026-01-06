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
  CreateRelationshipSchema
} from './tools/index.js';
import { QuickBaseConfig } from './types/quickbase.js';
import dotenv from 'dotenv';
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
dotenv.config();

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

    this.allowDestructive = String(process.env.QB_ALLOW_DESTRUCTIVE || '').toLowerCase() === 'true';
    this.readOnly = String(process.env.QB_READONLY || '').toLowerCase() === 'true';

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

      const destructiveTools = new Set([
        'quickbase_delete_table',
        'quickbase_delete_field',
        'quickbase_delete_record'
      ]);

      const readOnlyAllowedTools = new Set([
        'quickbase_get_app_info',
        'quickbase_get_tables',
        'quickbase_test_connection',
        'quickbase_get_table_info',
        'quickbase_get_table_fields',
        'quickbase_query_records',
        'quickbase_get_record',
        'quickbase_search_records',
        'quickbase_get_relationships',
        'quickbase_get_reports',
        'quickbase_run_report'
      ]);

      const confirmationRequiredTools = new Set([
        'quickbase_create_table',
        'quickbase_create_field',
        'quickbase_update_field',
        'quickbase_create_record',
        'quickbase_update_record',
        'quickbase_bulk_create_records',
        'quickbase_create_relationship'
      ]);

      const confirmed = typeof args === 'object' && args !== null && (args as any).confirm === true;

      try {
        if (this.readOnly && !readOnlyAllowedTools.has(name)) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Server is running in read-only mode (QB_READONLY=true). Tool \"${name}\" is not allowed.`
          );
        }

        if (destructiveTools.has(name) && !this.allowDestructive) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Destructive tool \"${name}\" is disabled. Set QB_ALLOW_DESTRUCTIVE=true to enable delete operations.`
          );
        }

        if (confirmationRequiredTools.has(name) && !confirmed) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Tool \"${name}\" can modify data or schema and requires confirmation. Re-run with { \"confirm\": true, ... }.`
          );
        }

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
                  text: `Record created with ID: ${newRecordId}`,
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
                  text: `Created ${recordIds.length} records: ${recordIds.join(', ')}`,
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