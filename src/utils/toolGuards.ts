import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export const destructiveTools = new Set([
  'quickbase_delete_table',
  'quickbase_delete_field',
  'quickbase_delete_record'
]);

export const readOnlyAllowedTools = new Set([
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

export const confirmationRequiredTools = new Set([
  'quickbase_create_table',
  'quickbase_create_field',
  'quickbase_update_field',
  'quickbase_create_record',
  'quickbase_update_record',
  'quickbase_bulk_create_records',
  'quickbase_create_relationship'
]);

export function assertToolAllowed(params: {
  name: string;
  args: unknown;
  readOnly: boolean;
  allowDestructive: boolean;
}): void {
  const { name, args, readOnly, allowDestructive } = params;

  const confirmed =
    typeof args === 'object' && args !== null && (args as any).confirm === true;

  if (readOnly && !readOnlyAllowedTools.has(name)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Server is running in read-only mode (QB_READONLY=true). Tool "${name}" is not allowed.`
    );
  }

  if (destructiveTools.has(name) && !allowDestructive) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Destructive tool "${name}" is disabled. Set QB_ALLOW_DESTRUCTIVE=true to enable delete operations.`
    );
  }

  if (confirmationRequiredTools.has(name) && !confirmed) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Tool "${name}" can modify data or schema and requires confirmation. Re-run with { "confirm": true, ... }.`
    );
  }
}
