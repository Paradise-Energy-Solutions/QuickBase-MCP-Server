import { z } from 'zod';

// QuickBase Field Types
export const FieldType = z.enum([
  'text',
  'text_choice',
  'text_multiline',
  'richtext',
  'numeric',
  'currency',
  'percent',
  'rating',
  'date',
  'datetime',
  'timeofday',
  'duration',
  'checkbox',
  'user',
  'multiselect',
  'email',
  'phone',
  'url',
  'address',
  'file',
  'lookup',
  'summary',
  'formula',
  'recordid',
  'reference',
  'autonumber'
]);

export type FieldType = z.infer<typeof FieldType>;

// QuickBase Field Schema
export const QuickBaseField = z.object({
  id: z.number().optional(),
  label: z.string(),
  fieldType: FieldType,
  required: z.boolean().default(false),
  unique: z.boolean().default(false),
  choices: z.array(z.string()).optional(),
  formula: z.string().optional(),
  lookupReference: z.object({
    tableId: z.string(),
    fieldId: z.number()
  }).optional(),
  properties: z.record(z.any()).optional()
});

export type QuickBaseField = z.infer<typeof QuickBaseField>;

// QuickBase Table Schema
export const QuickBaseTable = z.object({
  id: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  fields: z.array(QuickBaseField).default([]),
  relationships: z.array(z.object({
    parentTableId: z.string(),
    childTableId: z.string(),
    foreignKeyFieldId: z.number()
  })).default([])
});

export type QuickBaseTable = z.infer<typeof QuickBaseTable>;

// QuickBase Record Schema
export const QuickBaseRecord = z.object({
  recordId: z.number().optional(),
  fields: z.record(z.any())
});

export type QuickBaseRecord = z.infer<typeof QuickBaseRecord>;

// API Response Schemas
export const QuickBaseApiResponse = z.object({
  data: z.any(),
  metadata: z.object({
    numFields: z.number().optional(),
    numRecords: z.number().optional(),
    skip: z.number().optional(),
    top: z.number().optional(),
    totalRecords: z.number().optional()
  }).optional()
});

export type QuickBaseApiResponse = z.infer<typeof QuickBaseApiResponse>;

// Configuration Schema
export const QuickBaseConfig = z.object({
  realm: z.string(),
  userToken: z.string(),
  appId: z.string(),
  timeout: z.number().default(30000),
  maxRetries: z.number().default(3)
});

export type QuickBaseConfig = z.infer<typeof QuickBaseConfig>;

// Per-app configuration (loaded from environment at startup)
export interface AppConfig {
  id: string;
  name: string;
  readOnly: boolean;
  allowDestructive: boolean;
}

// Query Options
export const QueryOptions = z.object({
  select: z.array(z.number()).optional(),
  where: z.string().optional(),
  sortBy: z.array(z.object({
    fieldId: z.number(),
    order: z.enum(['ASC', 'DESC']).default('ASC')
  })).optional(),
  groupBy: z.array(z.number()).optional(),
  top: z.number().optional(),
  skip: z.number().optional()
});

export type QueryOptions = z.infer<typeof QueryOptions>;

// ========== PIPELINES (Unofficial API) ==========

// Pipeline IDs are large integers that may exceed Number.MAX_SAFE_INTEGER in
// future API versions, so we accept both number and string representations.
export const QuickBasePipeline = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string(),
  description: z.string().optional(),
  type: z.string().optional(),
  is_enabled: z.boolean().optional(),
  is_editable: z.boolean().optional(),
  channels: z.array(z.string()).optional(),
  tag_ids: z.array(z.number()).optional(),
  qb_realm_id: z.number().optional(),
  qb_user_id: z.number().optional(),
  qb_user_email: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  edited_at: z.string().optional()
});

export type QuickBasePipeline = z.infer<typeof QuickBasePipeline>;

export const QuickBasePipelineDetail = QuickBasePipeline.extend({
  tree: z.any().optional(),
  flags: z.any().optional(),
  state: z.string().optional(),
  errors: z.array(z.any()).optional(),
  warnings: z.array(z.any()).optional(),
  schedule: z.any().optional(),
  crontab: z.string().optional(),
  is_valid: z.boolean().optional(),
  triggered_at: z.string().optional()
});

export type QuickBasePipelineDetail = z.infer<typeof QuickBasePipelineDetail>;

export const QuickBasePipelineActivity = z.object({
  pipeline_id: z.union([z.number(), z.string()]).optional(),
  type: z.string().optional(),
  message: z.string().optional(),
  created_at: z.string().optional(),
  run_id: z.string().optional()
});

export type QuickBasePipelineActivity = z.infer<typeof QuickBasePipelineActivity>;

/**
 * Shape of the paged pipeline list response from the unofficial QB Pipelines API.
 * Fields are optional because the shape may change without notice.
 */
export interface PipelinesPage {
  pipelines: QuickBasePipeline[];
  totalCount?: number;
  pageNumber?: number;
  pageSize?: number;
  /** Injected client-side when realmWide=true and multiple owners are present. */
  _impersonationHint?: string;
  /** Injected client-side when filterByTableId is supplied. */
  _filterNote?: string;
  [key: string]: unknown;
}