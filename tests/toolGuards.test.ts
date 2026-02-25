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

  it('blocks destructive tools when QB_ALLOW_DESTRUCTIVE is false', () => {
    expect(() =>
      assertToolAllowed({
        name: 'quickbase_delete_record',
        args: { tableId: 'bux123', recordId: 1 },
        readOnly: false,
        allowDestructive: false
      })
    ).toThrow(/destructive tool/i);
  });

  describe('Webhook Tool Guards', () => {
    it('allows quickbase_list_webhooks in readonly mode', () => {
      expect(() =>
        assertToolAllowed({
          name: 'quickbase_list_webhooks',
          args: { tableId: 'bux123' },
          readOnly: true,
          allowDestructive: false
        })
      ).not.toThrow();
    });

    it('blocks quickbase_test_webhook in readonly mode', () => {
      expect(() =>
        assertToolAllowed({
          name: 'quickbase_test_webhook',
          args: { webhookUrl: 'https://example.com/webhook', testPayload: {} },
          readOnly: true,
          allowDestructive: false
        })
      ).toThrow(/read-only mode/i);
    });

    it('requires confirmation for quickbase_create_webhook', () => {
      expect(() =>
        assertToolAllowed({
          name: 'quickbase_create_webhook',
          args: {
            tableId: 'bux123',
            label: 'My Webhook',
            webhookUrl: 'https://example.com/webhook',
            webhookEvents: 'amd'
          },
          readOnly: false,
          allowDestructive: true
        })
      ).toThrow(/requires confirmation/i);

      expect(() =>
        assertToolAllowed({
          name: 'quickbase_create_webhook',
          args: {
            confirm: true,
            tableId: 'bux123',
            label: 'My Webhook',
            webhookUrl: 'https://example.com/webhook',
            webhookEvents: 'amd'
          },
          readOnly: false,
          allowDestructive: true
        })
      ).not.toThrow();
    });

    it('blocks quickbase_delete_webhook when destructive is disabled', () => {
      expect(() =>
        assertToolAllowed({
          name: 'quickbase_delete_webhook',
          args: { tableId: 'bux123', webhookId: 'webhook456' },
          readOnly: false,
          allowDestructive: false
        })
      ).toThrow(/destructive tool/i);
    });

    it('allows quickbase_delete_webhook when destructive is enabled', () => {
      expect(() =>
        assertToolAllowed({
          name: 'quickbase_delete_webhook',
          args: { tableId: 'bux123', webhookId: 'webhook456' },
          readOnly: false,
          allowDestructive: true
        })
      ).not.toThrow();
    });
  });

  describe('Notification Tool Guards', () => {
    it('allows quickbase_list_notifications in readonly mode', () => {
      expect(() =>
        assertToolAllowed({
          name: 'quickbase_list_notifications',
          args: { tableId: 'bux123' },
          readOnly: true,
          allowDestructive: false
        })
      ).not.toThrow();
    });

    it('requires confirmation for quickbase_create_notification', () => {
      expect(() =>
        assertToolAllowed({
          name: 'quickbase_create_notification',
          args: {
            tableId: 'bux123',
            label: 'Alert',
            notificationEvent: 'add',
            recipientEmail: 'user@example.com',
            messageSubject: 'New Record',
            messageBody: 'A record was added.'
          },
          readOnly: false,
          allowDestructive: true
        })
      ).toThrow(/requires confirmation/i);

      expect(() =>
        assertToolAllowed({
          name: 'quickbase_create_notification',
          args: {
            confirm: true,
            tableId: 'bux123',
            label: 'Alert',
            notificationEvent: 'add',
            recipientEmail: 'user@example.com',
            messageSubject: 'New Record',
            messageBody: 'A record was added.'
          },
          readOnly: false,
          allowDestructive: true
        })
      ).not.toThrow();
    });

    it('blocks quickbase_delete_notification when destructive is disabled', () => {
      expect(() =>
        assertToolAllowed({
          name: 'quickbase_delete_notification',
          args: { tableId: 'bux123', notificationId: 'notif789' },
          readOnly: false,
          allowDestructive: false
        })
      ).toThrow(/destructive tool/i);
    });

    it('allows quickbase_delete_notification when destructive is enabled', () => {
      expect(() =>
        assertToolAllowed({
          name: 'quickbase_delete_notification',
          args: { tableId: 'bux123', notificationId: 'notif789' },
          readOnly: false,
          allowDestructive: true
        })
      ).not.toThrow();
    });

    it('blocks quickbase_create_notification in readonly mode', () => {
      expect(() =>
        assertToolAllowed({
          name: 'quickbase_create_notification',
          args: {
            confirm: true,
            tableId: 'bux123',
            label: 'Alert',
            notificationEvent: 'add',
            recipientEmail: 'user@example.com',
            messageSubject: 'New Record',
            messageBody: 'Body'
          },
          readOnly: true,
          allowDestructive: true
        })
      ).toThrow(/read-only mode/i);
    });
  });
});
