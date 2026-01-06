import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { assertToolAllowed } from '../src/utils/toolGuards';

describe('Tool guards - readonly / destructive / confirmation', () => {
  it('blocks quickbase_update_record in readonly mode', () => {
    expect(() =>
      assertToolAllowed({
        name: 'quickbase_update_record',
        args: { confirm: true },
        readOnly: true,
        allowDestructive: true
      })
    ).toThrow(McpError);

    expect(() =>
      assertToolAllowed({
        name: 'quickbase_update_record',
        args: { confirm: true },
        readOnly: true,
        allowDestructive: true
      })
    ).toThrow(/read-only mode/i);
  });

  it('allows quickbase_get_record in readonly mode', () => {
    expect(() =>
      assertToolAllowed({
        name: 'quickbase_get_record',
        args: { tableId: 'bux123', recordId: 1 },
        readOnly: true,
        allowDestructive: false
      })
    ).not.toThrow();
  });

  it('requires confirmation for mutating tools when not readonly', () => {
    expect(() =>
      assertToolAllowed({
        name: 'quickbase_update_record',
        args: { tableId: 'bux123', recordId: 1, fields: { 6: 'x' } },
        readOnly: false,
        allowDestructive: true
      })
    ).toThrow(/requires confirmation/i);

    expect(() =>
      assertToolAllowed({
        name: 'quickbase_update_record',
        args: { confirm: true, tableId: 'bux123', recordId: 1, fields: { 6: 'x' } },
        readOnly: false,
        allowDestructive: true
      })
    ).not.toThrow();
  });
});
