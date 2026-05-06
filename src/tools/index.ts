import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// Read the relay port at module load time so tool descriptions reference the
// correct URL even when QB_RELAY_PORT overrides the default 3737.
const _relayPort = Number(process.env['QB_RELAY_PORT']) || 3737;
const _setupUrl = `http://localhost:${_relayPort}/setup`;

function validateFieldPayload(payload: unknown, ctx: z.RefinementCtx) {
  const maxDepth = 4;
  const maxKeysPerObject = 250;
  const maxTotalKeys = 2000;
  const maxStringLength = 10000;
  const maxArrayLength = 1000;

  let totalKeys = 0;

  const visit = (value: unknown, depth: number) => {
    if (depth > maxDepth) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Payload nesting too deep (max depth ${maxDepth}).` });
      return;
    }

    if (value === null || value === undefined) {
      return;
    }

    if (typeof value === 'string') {
      if (value.length > maxStringLength) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `String value too long (max ${maxStringLength} chars).` });
      }
      return;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return;
    }

    if (Array.isArray(value)) {
      if (value.length > maxArrayLength) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Array too large (max ${maxArrayLength} items).` });
        return;
      }
      for (const item of value) {
        visit(item, depth + 1);
      }
      return;
    }

    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj);

      if (keys.length > maxKeysPerObject) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Object has too many keys (max ${maxKeysPerObject}).` });
        return;
      }

      totalKeys += keys.length;

      if (totalKeys > maxTotalKeys) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Payload has too many keys overall (max ${maxTotalKeys}).` });
        return;
      }

      for (const k of keys) {
        if (k.length > 64) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Object key too long (max 64 chars).' });
          return;
        }
        visit(obj[k], depth + 1);
      }
      return;
    }

    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unsupported value type in payload: ${typeof value}` });
  };

  visit(payload, 0);
}

// Tool parameter schemas
const TableIdSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  tableId: z.string().min(3).max(64).describe('QuickBase table ID (e.g., "buXXXXXXX")')
});

const RecordIdSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  tableId: z.string().min(3).max(64).describe('QuickBase table ID'),
  recordId: z.number().describe('Record ID number')
});

const CreateTableSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  confirm: z.literal(true).describe('Required confirmation for schema-modifying operations'),
  name: z.string().min(1).max(128).describe('Table name'),
  description: z.string().max(1024).optional().describe('Table description')
});

const CreateFieldSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  confirm: z.literal(true).describe('Required confirmation for schema-modifying operations'),
  tableId: z.string().min(3).max(64).describe('Table ID to add field to'),
  label: z.string().min(1).max(128).describe('Field label/name'),
  fieldType: z.enum([
    'text', 'text_choice', 'text_multiline', 'richtext', 'numeric', 
    'currency', 'percent', 'date', 'datetime', 'checkbox', 'email', 
    'phone', 'url', 'address', 'file', 'lookup', 'formula', 'reference'
  ]).describe('Type of field'),
  required: z.boolean().default(false).describe('Whether field is required'),
  unique: z.boolean().default(false).describe('Whether field must be unique'),
  choices: z.array(z.string().max(256)).max(500).optional().describe('Choices for choice fields'),
  formula: z.string().max(10000).optional().describe('Formula for formula fields'),
  lookupTableId: z.string().min(3).max(64).optional().describe('Table ID for lookup fields'),
  lookupFieldId: z.number().optional().describe('Field ID for lookup fields')
});

const QueryRecordsSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  tableId: z.string().min(3).max(64).describe('Table ID to query'),
  select: z.array(z.number()).optional().describe('Field IDs to select'),
  where: z.string().max(5000).optional().describe('QuickBase query filter'),
  sortBy: z.array(z.object({
    fieldId: z.number(),
    order: z.enum(['ASC', 'DESC']).default('ASC')
  })).optional().describe('Sort criteria'),
  top: z.number().int().min(1).max(1000).optional().describe('Max number of records'),
  skip: z.number().int().min(0).max(100000).optional().describe('Number of records to skip')
});

const CreateRecordSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  confirm: z.literal(true).describe('Required confirmation for data-modifying operations'),
  tableId: z.string().min(3).max(64).describe('Table ID to create record in'),
  fields: z.record(z.any())
    .superRefine((v, ctx) => validateFieldPayload(v, ctx))
    .describe('Field values as fieldId: value pairs')
});

const UpdateRecordSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  confirm: z.literal(true).describe('Required confirmation for data-modifying operations'),
  tableId: z.string().min(3).max(64).describe('Table ID'),
  recordId: z.number().describe('Record ID to update'),
  fields: z.record(z.any())
    .superRefine((v, ctx) => validateFieldPayload(v, ctx))
    .describe('Field values to update as fieldId: value pairs')
});

const BulkCreateSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  confirm: z.literal(true).describe('Required confirmation for data-modifying operations'),
  tableId: z.string().min(3).max(64).describe('Table ID'),
  records: z.array(z.object({
    fields: z.record(z.any()).superRefine((v, ctx) => validateFieldPayload(v, ctx))
  })).max(250).describe('Array of records to create')
});

const SearchRecordsSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  tableId: z.string().min(3).max(64).describe('Table ID to search'),
  searchTerm: z.string().min(1).max(200).describe('Text to search for'),
  fieldIds: z.array(z.number()).optional().describe('Field IDs to search in')
});

const CreateRelationshipSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  confirm: z.literal(true).describe('Required confirmation for schema-modifying operations'),
  parentTableId: z.string().min(3).max(64).describe('Parent table ID'),
  childTableId: z.string().min(3).max(64).describe('Child table ID'),
  foreignKeyFieldId: z.number().describe('Foreign key field ID in child table')
});

const CreateAdvancedRelationshipSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  confirm: z.literal(true).describe('Required confirmation for schema-modifying operations'),
  parentTableId: z.string().describe('Parent table ID'),
  childTableId: z.string().describe('Child table ID'),
  referenceFieldLabel: z.string().describe('Label for the reference field to create'),
  lookupFields: z.array(z.object({
    parentFieldId: z.number().describe('Field ID in parent table to lookup'),
    childFieldLabel: z.string().describe('Label for lookup field in child table')
  })).optional().describe('Lookup fields to create automatically'),
  relationshipType: z.enum(['one-to-many', 'many-to-many']).default('one-to-many').describe('Type of relationship')
});

const CreateLookupFieldSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  confirm: z.literal(true).describe('Required confirmation for schema-modifying operations'),
  childTableId: z.string().describe('Child table ID where lookup field will be created'),
  parentTableId: z.string().describe('Parent table ID to lookup from'),
  referenceFieldId: z.number().describe('Reference field ID in child table'),
  parentFieldId: z.number().describe('Field ID in parent table to lookup'),
  lookupFieldLabel: z.string().describe('Label for the new lookup field')
});

const ValidateRelationshipSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  parentTableId: z.string().describe('Parent table ID'),
  childTableId: z.string().describe('Child table ID'),
  foreignKeyFieldId: z.number().describe('Foreign key field ID to validate')
});

const CreateJunctionTableSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  confirm: z.literal(true).describe('Required confirmation for schema-modifying operations'),
  junctionTableName: z.string().describe('Name for the junction table'),
  table1Id: z.string().describe('First table ID'),
  table2Id: z.string().describe('Second table ID'),
  table1FieldLabel: z.string().describe('Label for reference to first table'),
  table2FieldLabel: z.string().describe('Label for reference to second table'),
  additionalFields: z.array(z.object({
    label: z.string(),
    fieldType: z.string()
  })).optional().describe('Additional fields for the junction table')
});

const GetRelationshipDetailsSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  tableId: z.string().describe('Table ID to analyze relationships for'),
  includeFields: z.boolean().default(true).describe('Include related field details')
});

// ========== WEBHOOK SCHEMAS ==========

const CreateWebhookSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  confirm: z.literal(true).describe('Required confirmation for schema-modifying operations'),
  tableId: z.string().min(3).max(64).describe('Table ID'),
  label: z.string().min(1).max(128).describe('Unique name for the webhook'),
  description: z.string().max(1024).optional().describe('Webhook description'),
  webhookUrl: z.string()
    .url()
    .refine(val => val.startsWith('https://'), { message: 'Webhook URL must use the HTTPS scheme' })
    .describe('HTTPS endpoint URL for the webhook'),
  webhookEvents: z.string()
    .refine(val => /^[adm]+$/.test(val))
    .describe('Trigger events: a (add), d (delete), m (modify) - combine as needed (e.g., "amd")'),
  messageFormat: z.enum(['XML', 'JSON', 'RAW']).default('JSON').optional().describe('Payload format'),
  messageBody: z.string().max(10000).optional().describe('Custom webhook message/payload'),
  webhookHeaders: z.record(z.string()).optional().describe('Custom HTTP headers'),
  httpMethod: z.enum(['POST', 'GET', 'PUT', 'PATCH', 'DELETE']).default('POST').optional().describe('HTTP method'),
  triggerFields: z.array(z.number()).optional().describe('Only trigger on changes to specific field IDs')
});

const ListWebhooksSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  tableId: z.string().min(3).max(64).describe('Table ID')
});

const DeleteWebhookSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  tableId: z.string().min(3).max(64).describe('Table ID'),
  webhookId: z.string().describe('Webhook ID to delete')
});

const TestWebhookSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  webhookUrl: z.string()
    .url()
    .refine(url => url.startsWith('https://'), { message: 'Webhook URL must use the HTTPS scheme' })
    .describe('HTTPS webhook URL to test'),
  testPayload: z.record(z.any()).describe('Test payload to send'),
  headers: z.record(z.string()).optional().describe('Optional custom headers')
});

// ========== NOTIFICATION SCHEMAS ==========

const CreateNotificationSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  confirm: z.literal(true).describe('Required confirmation for schema-modifying operations'),
  tableId: z.string().min(3).max(64).describe('Table ID'),
  label: z.string().min(1).max(128).describe('Unique name for the notification'),
  description: z.string().max(1024).optional().describe('Notification description'),
  notificationEvent: z.enum(['add', 'modify', 'delete']).describe('Trigger event type'),
  recipientEmail: z.string().email().describe('Email recipient'),
  messageSubject: z.string().min(1).max(256).describe('Email subject'),
  messageBody: z.string().min(1).max(10000).describe('Email body/content'),
  includeAllFields: z.boolean().default(false).optional().describe('Include all field values in notification'),
  triggerFields: z.array(z.number()).optional().describe('Only trigger on changes to specific field IDs')
});

const ListNotificationsSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  tableId: z.string().min(3).max(64).describe('Table ID')
});

const DeleteNotificationSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  tableId: z.string().min(3).max(64).describe('Table ID'),
  notificationId: z.string().describe('Notification ID to delete')
});

// ========== PIPELINE SCHEMAS ==========

const ListPipelinesSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  pageNumber: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  realmWide: z.boolean().default(false),
  impersonateUserId: z.string().optional(),
  filterByTableId: z.string().optional().describe('Return only pipelines whose trigger table ID matches this value (client-side filter)')
});

const GetPipelineSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  pipelineId: z.string().min(1),
  impersonateUserId: z.string().optional()
});

const GetPipelineActivitySchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  pipelineId: z.string().min(1),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  perPage: z.number().int().min(1).max(100).default(25),
  impersonateUserId: z.string().optional(),
  recordId: z.union([z.string(), z.number()]).optional().describe('Filter activity to runs triggered by this specific record ID')
});

const FindPipelineUsersSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  query: z.string().min(1).max(128)
});

const GetPipelineStepSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  pipelineId: z.string().min(1).max(256).describe('Pipeline numeric ID (from quickbase_list_pipelines)'),
  stepId: z.string().min(1).max(256).describe('Step/node ID (from quickbase_get_pipeline nodes array)'),
  impersonateUserId: z.string().optional()
});

const GetPipelineTriggerSummarySchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  pipelineId: z.string().min(1).max(256).describe('Pipeline numeric ID'),
  impersonateUserId: z.string().optional()
});

const BatchGetPipelineStepsSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  steps: z.array(z.object({
    pipelineId: z.string().min(1).max(256).describe('Pipeline numeric ID'),
    stepId: z.string().min(1).max(256).describe('Step/node ID')
  })).min(1).max(20).describe('List of pipeline+step pairs to fetch (max 20)'),
  impersonateUserId: z.string().optional()
});

const StartImpersonationSchema = z.object({
  appId: z.string().min(1).max(64).describe('QuickBase application ID'),
  qbUserId: z.string().min(1)
});

// Injects appId into a tool's JSON Schema properties and required list
function withAppId(tool: Tool): Tool {
  return {
    ...tool,
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'QuickBase application ID' },
        ...(tool.inputSchema as any).properties
      },
      required: ['appId', ...((tool.inputSchema as any).required ?? [])]
    }
  };
}

// Define all MCP tools
const rawTools: Tool[] = [
  // ========== APPLICATION TOOLS ==========
  {
    name: 'quickbase_get_app_info',
    description: 'Get information about the QuickBase application',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },

  {
    name: 'quickbase_get_tables',
    description: 'Get list of all tables in the application',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },

  {
    name: 'quickbase_test_connection',
    description: 'Test connection to QuickBase',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },

  // ========== TABLE TOOLS ==========
  {
    name: 'quickbase_create_table',
    description: 'Create a new table in QuickBase',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Required confirmation for schema-modifying operations (must be true)' },
        name: { type: 'string', description: 'Table name' },
        description: { type: 'string', description: 'Table description' }
      },
      required: ['confirm', 'name']
    }
  },

  {
    name: 'quickbase_get_table_info',
    description: 'Get detailed information about a specific table',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'QuickBase table ID' }
      },
      required: ['tableId']
    }
  },

  {
    name: 'quickbase_delete_table',
    description: 'Delete a table from QuickBase',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'QuickBase table ID to delete' }
      },
      required: ['tableId']
    }
  },

  // ========== FIELD TOOLS ==========
  {
    name: 'quickbase_get_table_fields',
    description: 'Get all fields for a table',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'QuickBase table ID' }
      },
      required: ['tableId']
    }
  },

  {
    name: 'quickbase_create_field',
    description: 'Create a new field in a table',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Required confirmation for schema-modifying operations (must be true)' },
        tableId: { type: 'string', description: 'Table ID to add field to' },
        label: { type: 'string', description: 'Field label/name' },
        fieldType: { 
          type: 'string',
          enum: ['text', 'text_choice', 'text_multiline', 'richtext', 'numeric', 'currency', 'percent', 'date', 'datetime', 'checkbox', 'email', 'phone', 'url', 'address', 'file', 'lookup', 'formula', 'reference'],
          description: 'Type of field'
        },
        required: { type: 'boolean', description: 'Whether field is required', default: false },
        unique: { type: 'boolean', description: 'Whether field must be unique', default: false },
        choices: { type: 'array', items: { type: 'string' }, description: 'Choices for choice fields' },
        formula: { type: 'string', description: 'Formula for formula fields' },
        lookupTableId: { type: 'string', description: 'Table ID for lookup fields' },
        lookupFieldId: { type: 'number', description: 'Field ID for lookup fields' }
      },
      required: ['confirm', 'tableId', 'label', 'fieldType']
    }
  },

  {
    name: 'quickbase_update_field',
    description: 'Update an existing field',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Required confirmation for schema-modifying operations (must be true)' },
        tableId: { type: 'string', description: 'Table ID' },
        fieldId: { type: 'number', description: 'Field ID to update' },
        label: { type: 'string', description: 'New field label' },
        required: { type: 'boolean', description: 'Whether field is required' },
        choices: { type: 'array', items: { type: 'string' }, description: 'New choices for choice fields' }
      },
      required: ['confirm', 'tableId', 'fieldId']
    }
  },

  {
    name: 'quickbase_delete_field',
    description: 'Delete a field from a table',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'Table ID' },
        fieldId: { type: 'number', description: 'Field ID to delete' }
      },
      required: ['tableId', 'fieldId']
    }
  },

  // ========== RECORD TOOLS ==========
  {
    name: 'quickbase_query_records',
    description: 'Query records from a table with optional filtering and sorting',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'Table ID to query' },
        select: { type: 'array', items: { type: 'number' }, description: 'Field IDs to select' },
        where: { type: 'string', description: 'QuickBase query filter (e.g., "{6.EX.\'John\'}")' },
        sortBy: { 
          type: 'array', 
          items: {
            type: 'object',
            properties: {
              fieldId: { type: 'number' },
              order: { type: 'string', enum: ['ASC', 'DESC'] }
            }
          },
          description: 'Sort criteria'
        },
        top: { type: 'number', description: 'Max number of records' },
        skip: { type: 'number', description: 'Number of records to skip' }
      },
      required: ['tableId']
    }
  },

  {
    name: 'quickbase_get_record',
    description: 'Get a specific record by ID',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'Table ID' },
        recordId: { type: 'number', description: 'Record ID' },
        fieldIds: { type: 'array', items: { type: 'number' }, description: 'Specific field IDs to retrieve' }
      },
      required: ['tableId', 'recordId']
    }
  },

  {
    name: 'quickbase_create_record',
    description: 'Create a new record in a table',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Required confirmation for data-modifying operations (must be true)' },
        tableId: { type: 'string', description: 'Table ID to create record in' },
        fields: { 
          type: 'object', 
          description: 'Field values as fieldId: {value: actualValue} pairs',
          additionalProperties: true
        }
      },
      required: ['confirm', 'tableId', 'fields']
    }
  },

  {
    name: 'quickbase_update_record',
    description: 'Update an existing record',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Required confirmation for data-modifying operations (must be true)' },
        tableId: { type: 'string', description: 'Table ID' },
        recordId: { type: 'number', description: 'Record ID to update' },
        fields: { 
          type: 'object', 
          description: 'Field values to update as fieldId: {value: actualValue} pairs',
          additionalProperties: true
        }
      },
      required: ['confirm', 'tableId', 'recordId', 'fields']
    }
  },

  {
    name: 'quickbase_delete_record',
    description: 'Delete a record from a table',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'Table ID' },
        recordId: { type: 'number', description: 'Record ID to delete' }
      },
      required: ['tableId', 'recordId']
    }
  },

  {
    name: 'quickbase_bulk_create_records',
    description: 'Create multiple records at once',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Required confirmation for data-modifying operations (must be true)' },
        tableId: { type: 'string', description: 'Table ID' },
        records: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              fields: { type: 'object', additionalProperties: true }
            }
          },
          description: 'Array of records to create'
        }
      },
      required: ['confirm', 'tableId', 'records']
    }
  },

  {
    name: 'quickbase_search_records',
    description: 'Search for records containing specific text',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'Table ID to search' },
        searchTerm: { type: 'string', description: 'Text to search for' },
        fieldIds: { type: 'array', items: { type: 'number' }, description: 'Field IDs to search in' }
      },
      required: ['tableId', 'searchTerm']
    }
  },

  // ========== RELATIONSHIP TOOLS ==========
  {
    name: 'quickbase_create_relationship',
    description: 'Create a parent-child relationship between tables',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Required confirmation for schema-modifying operations (must be true)' },
        parentTableId: { type: 'string', description: 'Parent table ID' },
        childTableId: { type: 'string', description: 'Child table ID' },
        foreignKeyFieldId: { type: 'number', description: 'Foreign key field ID in child table' }
      },
      required: ['confirm', 'parentTableId', 'childTableId', 'foreignKeyFieldId']
    }
  },

  {
    name: 'quickbase_get_relationships',
    description: 'Get relationships for a table',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'Table ID' }
      },
      required: ['tableId']
    }
  },

  // ========== UTILITY TOOLS ==========
  {
    name: 'quickbase_get_reports',
    description: 'Get all reports for a table',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'Table ID' }
      },
      required: ['tableId']
    }
  },

  {
    name: 'quickbase_run_report',
    description: 'Run a specific report',
    inputSchema: {
      type: 'object',
      properties: {
        reportId: { type: 'string', description: 'Report ID' },
        tableId: { type: 'string', description: 'Table ID' }
      },
      required: ['reportId', 'tableId']
    }
  },

  // ========== ENHANCED RELATIONSHIP TOOLS ==========
  {
    name: 'quickbase_create_advanced_relationship',
    description: 'Create a comprehensive table relationship with automatic lookup fields',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Required confirmation for schema-modifying operations (must be true)' },
        parentTableId: { type: 'string', description: 'Parent table ID' },
        childTableId: { type: 'string', description: 'Child table ID' },
        referenceFieldLabel: { type: 'string', description: 'Label for the reference field to create' },
        lookupFields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              parentFieldId: { type: 'number', description: 'Field ID in parent table to lookup' },
              childFieldLabel: { type: 'string', description: 'Label for lookup field in child table' }
            },
            required: ['parentFieldId', 'childFieldLabel']
          },
          description: 'Lookup fields to create automatically'
        },
        relationshipType: { 
          type: 'string', 
          enum: ['one-to-many', 'many-to-many'], 
          default: 'one-to-many',
          description: 'Type of relationship' 
        }
      },
      required: ['confirm', 'parentTableId', 'childTableId', 'referenceFieldLabel']
    }
  },

  {
    name: 'quickbase_create_lookup_field',
    description: 'Create a lookup field to pull data from a related table',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Required confirmation for schema-modifying operations (must be true)' },
        childTableId: { type: 'string', description: 'Child table ID where lookup field will be created' },
        parentTableId: { type: 'string', description: 'Parent table ID to lookup from' },
        referenceFieldId: { type: 'number', description: 'Reference field ID in child table' },
        parentFieldId: { type: 'number', description: 'Field ID in parent table to lookup' },
        lookupFieldLabel: { type: 'string', description: 'Label for the new lookup field' }
      },
      required: ['confirm', 'childTableId', 'parentTableId', 'referenceFieldId', 'parentFieldId', 'lookupFieldLabel']
    }
  },

  {
    name: 'quickbase_validate_relationship',
    description: 'Validate the integrity of a table relationship',
    inputSchema: {
      type: 'object',
      properties: {
        parentTableId: { type: 'string', description: 'Parent table ID' },
        childTableId: { type: 'string', description: 'Child table ID' },
        foreignKeyFieldId: { type: 'number', description: 'Foreign key field ID to validate' }
      },
      required: ['parentTableId', 'childTableId', 'foreignKeyFieldId']
    }
  },

  {
    name: 'quickbase_get_relationship_details',
    description: 'Get detailed information about table relationships including lookup fields',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'Table ID to analyze relationships for' },
        includeFields: { type: 'boolean', default: true, description: 'Include related field details' }
      },
      required: ['tableId']
    }
  },

  {
    name: 'quickbase_create_junction_table',
    description: 'Create a junction table for many-to-many relationships',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Required confirmation for schema-modifying operations (must be true)' },
        junctionTableName: { type: 'string', description: 'Name for the junction table' },
        table1Id: { type: 'string', description: 'First table ID' },
        table2Id: { type: 'string', description: 'Second table ID' },
        table1FieldLabel: { type: 'string', description: 'Label for reference to first table' },
        table2FieldLabel: { type: 'string', description: 'Label for reference to second table' },
        additionalFields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              fieldType: { type: 'string' }
            }
          },
          description: 'Additional fields for the junction table'
        }
      },
      required: ['confirm', 'junctionTableName', 'table1Id', 'table2Id', 'table1FieldLabel', 'table2FieldLabel']
    }
  },

  // ========== WEBHOOK TOOLS ==========
  {
    name: 'quickbase_create_webhook',
    description: 'Create a webhook for table events (add, modify, delete)',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Required confirmation for schema-modifying operations (must be true)' },
        tableId: { type: 'string', description: 'Table ID' },
        label: { type: 'string', description: 'Unique name for the webhook' },
        description: { type: 'string', description: 'Webhook description' },
        webhookUrl: { type: 'string', description: 'HTTPS endpoint URL for the webhook' },
        webhookEvents: { type: 'string', description: 'Trigger events: a (add), d (delete), m (modify) - combine as needed (e.g., "amd")' },
        messageFormat: { type: 'string', enum: ['XML', 'JSON', 'RAW'], default: 'JSON', description: 'Payload format' },
        messageBody: { type: 'string', description: 'Custom webhook message/payload' },
        webhookHeaders: { type: 'object', additionalProperties: { type: 'string' }, description: 'Custom HTTP headers' },
        httpMethod: { type: 'string', enum: ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'], default: 'POST', description: 'HTTP method' },
        triggerFields: { type: 'array', items: { type: 'number' }, description: 'Only trigger on changes to specific field IDs' }
      },
      required: ['confirm', 'tableId', 'label', 'webhookUrl', 'webhookEvents']
    }
  },

  {
    name: 'quickbase_list_webhooks',
    description: 'List all webhooks for a table',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'Table ID' }
      },
      required: ['tableId']
    }
  },

  {
    name: 'quickbase_delete_webhook',
    description: 'Delete a webhook from a table',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'Table ID' },
        webhookId: { type: 'string', description: 'Webhook ID to delete' }
      },
      required: ['tableId', 'webhookId']
    }
  },

  {
    name: 'quickbase_test_webhook',
    description: 'Test a webhook by sending a test payload',
    inputSchema: {
      type: 'object',
      properties: {
        webhookUrl: { type: 'string', description: 'Webhook URL to test' },
        testPayload: { type: 'object', description: 'Test payload to send', additionalProperties: true },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional custom headers' }
      },
      required: ['webhookUrl', 'testPayload']
    }
  },

  // ========== NOTIFICATION TOOLS ==========
  {
    name: 'quickbase_create_notification',
    description: 'Create an email notification for table record events',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Required confirmation for schema-modifying operations (must be true)' },
        tableId: { type: 'string', description: 'Table ID' },
        label: { type: 'string', description: 'Unique name for the notification' },
        description: { type: 'string', description: 'Notification description' },
        notificationEvent: { type: 'string', enum: ['add', 'modify', 'delete'], description: 'Trigger event type' },
        recipientEmail: { type: 'string', description: 'Email recipient' },
        messageSubject: { type: 'string', description: 'Email subject' },
        messageBody: { type: 'string', description: 'Email body/content' },
        includeAllFields: { type: 'boolean', default: false, description: 'Include all field values in notification' },
        triggerFields: { type: 'array', items: { type: 'number' }, description: 'Only trigger on changes to specific field IDs' }
      },
      required: ['confirm', 'tableId', 'label', 'notificationEvent', 'recipientEmail', 'messageSubject', 'messageBody']
    }
  },

  {
    name: 'quickbase_list_notifications',
    description: 'List all email notifications for a table',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'Table ID' }
      },
      required: ['tableId']
    }
  },

  {
    name: 'quickbase_delete_notification',
    description: 'Delete an email notification from a table',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'Table ID' },
        notificationId: { type: 'string', description: 'Notification ID to delete' }
      },
      required: ['tableId', 'notificationId']
    }
  },

  // ========== PIPELINE TOOLS (Unofficial API) ==========

  {
    name: 'quickbase_list_pipelines',
    description: `[UNOFFICIAL API — may break without notice] List QuickBase Pipelines. Returns pipelines owned by the currently logged-in browser user. To list pipelines belonging to a different user, pass their QB user ID via impersonateUserId — the server handles impersonation automatically (use quickbase_find_pipeline_users to look up a user ID by name or email). Set realmWide=true to list all realm pipelines regardless of owner (admin only). Requires the QB Pipeline Relay bookmarklet to be active on the Pipelines dashboard. First-time setup: ${_setupUrl} (port configurable via QB_RELAY_PORT in .env).`,
    inputSchema: {
      type: 'object',
      properties: {
        pageNumber: { type: 'number', description: 'Page number (default 1)' },
        pageSize: { type: 'number', description: 'Results per page (default 25)' },
        realmWide: { type: 'boolean', description: 'If true, return all realm pipelines regardless of owner (requires admin). Default false.' },
        impersonateUserId: { type: 'string', description: 'QB user ID whose pipelines to retrieve (e.g. "62913114"). The server impersonates this user automatically — your browser session is unaffected. Use quickbase_find_pipeline_users to find a user ID by name or email.' },
        filterByTableId: { type: 'string', description: 'Return only pipelines whose trigger table ID matches this value. Use when looking for pipelines watching a specific table.' }
      },
      required: []
    }
  },

  {
    name: 'quickbase_get_pipeline',
    description: `[UNOFFICIAL API — may break without notice] Get the full definition (JSON tree) of a QuickBase Pipeline by its numeric ID. Requires the QB Pipeline Relay bookmarklet to be active on the Pipelines dashboard (setup: ${_setupUrl} — port configurable via QB_RELAY_PORT in .env).`,
    inputSchema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'string', description: 'Pipeline numeric ID (e.g. "6721062615859200")' },
        impersonateUserId: { type: 'string', description: 'QB user ID to impersonate. Required if the pipeline belongs to a different user — the server handles it automatically. Use quickbase_find_pipeline_users to look up a user ID.' }
      },
      required: ['pipelineId']
    }
  },

  {
    name: 'quickbase_get_pipeline_activity',
    description: `[UNOFFICIAL API — may break without notice] Get the activity / run history for a QuickBase Pipeline. Requires the QB Pipeline Relay bookmarklet to be active on the Pipelines dashboard (setup: ${_setupUrl} — port configurable via QB_RELAY_PORT in .env).`,
    inputSchema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'string', description: 'Pipeline numeric ID' },
        startDate: { type: 'string', description: 'ISO 8601 start date (default: 7 days ago)' },
        endDate: { type: 'string', description: 'ISO 8601 end date (default: now)' },
        perPage: { type: 'number', description: 'Results per page (default 25)' },
        impersonateUserId: { type: 'string', description: 'QB user ID to impersonate. Required if the pipeline belongs to a different user — the server handles it automatically. Use quickbase_find_pipeline_users to look up a user ID.' },
        recordId: { type: 'string', description: 'Filter activity to runs triggered by this specific record ID.' }
      },
      required: ['pipelineId']
    }
  },

  {
    name: 'quickbase_find_pipeline_users',
    description: `[UNOFFICIAL API — may break without notice] Search for QuickBase realm users by name or email. Useful for finding user IDs to pass to impersonateUserId. Requires the QB Pipeline Relay bookmarklet to be active (setup: ${_setupUrl} — port configurable via QB_RELAY_PORT in .env).`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or email fragment to search for' }
      },
      required: ['query']
    }
  },

  {
    name: 'quickbase_get_pipeline_step',
    description: `[UNOFFICIAL API — may break without notice] Get the operational configuration of a specific step/node within a QuickBase Pipeline (channel, action, field mappings, webhook URL, conditions). Use quickbase_get_pipeline first to get node IDs from the tree. Requires the QB Pipeline Relay bookmarklet to be active (setup: ${_setupUrl} — port configurable via QB_RELAY_PORT in .env).`,
    inputSchema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'string', description: 'Pipeline numeric ID' },
        stepId: { type: 'string', description: 'Step/node numeric ID (from the nodes array returned by quickbase_get_pipeline)' },
        impersonateUserId: { type: 'string', description: 'QB user ID to impersonate. Use quickbase_find_pipeline_users to look up a user ID.' }
      },
      required: ['pipelineId', 'stepId']
    }
  },

  {
    name: 'quickbase_get_pipeline_trigger_summary',
    description: `[UNOFFICIAL API — may break without notice] Get a lightweight summary of what a pipeline triggers on: trigger table, event type (record added/modified/deleted), watched fields, and filter conditions. Faster than quickbase_get_pipeline when you only need to answer "what does this pipeline watch?". Requires the QB Pipeline Relay bookmarklet to be active (setup: ${_setupUrl} — port configurable via QB_RELAY_PORT in .env).`,
    inputSchema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'string', description: 'Pipeline numeric ID' },
        impersonateUserId: { type: 'string', description: 'QB user ID to impersonate. Use quickbase_find_pipeline_users to look up a user ID.' }
      },
      required: ['pipelineId']
    }
  },

  {
    name: 'quickbase_batch_get_pipeline_steps',
    description: `[UNOFFICIAL API — may break without notice] Fetch the configuration of multiple pipeline steps in a single call. Accepts an array of { pipelineId, stepId } pairs (max 20) and returns each step's config or an error if a step cannot be fetched. Reduces round-trips compared to calling quickbase_get_pipeline_step individually. Requires the QB Pipeline Relay bookmarklet to be active (setup: ${_setupUrl} — port configurable via QB_RELAY_PORT in .env).`,
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'Array of { pipelineId, stepId } pairs to fetch (max 20)',
          items: {
            type: 'object',
            properties: {
              pipelineId: { type: 'string' },
              stepId: { type: 'string' }
            },
            required: ['pipelineId', 'stepId']
          },
          maxItems: 20
        },
        impersonateUserId: { type: 'string', description: 'QB user ID to impersonate. Use quickbase_find_pipeline_users to look up a user ID.' }
      },
      required: ['steps']
    }
  },

  {
    name: 'quickbase_start_impersonation',
    description: `[UNOFFICIAL API — may break without notice] Start impersonating a QuickBase user. While active, subsequent pipeline tool calls operate as that user. Call quickbase_end_impersonation when done. Requires the QB Pipeline Relay bookmarklet to be active (setup: ${_setupUrl} — port configurable via QB_RELAY_PORT in .env).`,
    inputSchema: {
      type: 'object',
      properties: {
        qbUserId: { type: 'string', description: 'QuickBase user ID to impersonate (e.g. "62913114")' }
      },
      required: ['qbUserId']
    }
  },

  {
    name: 'quickbase_end_impersonation',
    description: `[UNOFFICIAL API — may break without notice] Stop impersonating a QuickBase user and return to the default authenticated user. Requires the QB Pipeline Relay bookmarklet to be active (setup: ${_setupUrl} — port configurable via QB_RELAY_PORT in .env).`,
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
];

export const quickbaseTools: Tool[] = [
  {
    name: 'quickbase_list_apps',
    description: 'Lists all QuickBase applications registered in this server\'s configuration. Use the returned appId values when calling other tools. Call quickbase_get_app_info with an appId to fetch live app details from QuickBase.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  ...rawTools.map(withAppId)
];

// Export schemas for validation
export {
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
  GetPipelineActivitySchema,
  FindPipelineUsersSchema,
  GetPipelineStepSchema,
  GetPipelineTriggerSummarySchema,
  BatchGetPipelineStepsSchema,
  StartImpersonationSchema
}; 