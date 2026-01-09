import {
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
  CreateWebhookSchema,
  ListWebhooksSchema,
  DeleteWebhookSchema,
  TestWebhookSchema,
  CreateNotificationSchema,
  ListNotificationsSchema,
  DeleteNotificationSchema,
  quickbaseTools
} from '../src/tools/index';

describe('Tool Schemas - Validation', () => {
  describe('TableIdSchema', () => {
    it('should validate valid table ID', () => {
      const data = { tableId: 'bux123' };
      expect(TableIdSchema.parse(data)).toEqual(data);
    });

    it('should validate different table ID formats', () => {
      expect(TableIdSchema.parse({ tableId: 'bux' }).tableId).toBe('bux');
      expect(TableIdSchema.parse({ tableId: 'a'.repeat(64) }).tableId.length).toBe(64);
    });

    it('should reject table ID too short', () => {
      expect(() => TableIdSchema.parse({ tableId: 'bu' })).toThrow();
    });

    it('should reject table ID too long', () => {
      expect(() => TableIdSchema.parse({ tableId: 'a'.repeat(65) })).toThrow();
    });

    it('should require tableId', () => {
      expect(() => TableIdSchema.parse({})).toThrow();
    });
  });

  describe('RecordIdSchema', () => {
    it('should validate record with tableId and recordId', () => {
      const data = { tableId: 'bux123', recordId: 42 };
      expect(RecordIdSchema.parse(data)).toEqual(data);
    });

    it('should reject missing tableId', () => {
      expect(() => RecordIdSchema.parse({ recordId: 42 })).toThrow();
    });

    it('should reject missing recordId', () => {
      expect(() => RecordIdSchema.parse({ tableId: 'bux123' })).toThrow();
    });

    it('should reject non-numeric recordId', () => {
      expect(() => RecordIdSchema.parse({ tableId: 'bux123', recordId: 'abc' })).toThrow();
    });
  });

  describe('CreateTableSchema', () => {
    it('should validate table creation with required fields', () => {
      const data = { confirm: true, name: 'Contacts' };
      expect(CreateTableSchema.parse(data)).toEqual(data);
    });

    it('should validate with description', () => {
      const data = { confirm: true, name: 'Contacts', description: 'All contacts' };
      expect(CreateTableSchema.parse(data)).toEqual(data);
    });

    it('should require confirm: true', () => {
      // Expect validation error about invalid literal value or required field
      expect(() => CreateTableSchema.parse({ confirm: false, name: 'Test' })).toThrow();
      expect(() => CreateTableSchema.parse({ name: 'Test' })).toThrow();
    });

    it('should require name', () => {
      expect(() => CreateTableSchema.parse({ confirm: true })).toThrow();
    });

    it('should enforce name max length', () => {
      const longName = 'a'.repeat(129);
      expect(() => CreateTableSchema.parse({ confirm: true, name: longName })).toThrow();
    });

    it('should enforce description max length', () => {
      const longDesc = 'a'.repeat(1025);
      expect(() => CreateTableSchema.parse({
        confirm: true,
        name: 'Test',
        description: longDesc
      })).toThrow();
    });
  });

  describe('CreateFieldSchema', () => {
    it('should validate basic field creation', () => {
      const data = {
        confirm: true,
        tableId: 'bux123',
        label: 'Email',
        fieldType: 'email'
      };
      expect(CreateFieldSchema.parse(data)).toMatchObject(data);
    });

    it('should validate field with all optional properties', () => {
      const data = {
        confirm: true,
        tableId: 'bux123',
        label: 'Status',
        fieldType: 'text_choice',
        required: true,
        unique: true,
        choices: ['Active', 'Inactive']
      };
      expect(CreateFieldSchema.parse(data)).toMatchObject(data);
    });

    it('should require confirm: true', () => {
      expect(() => CreateFieldSchema.parse({
        tableId: 'bux123',
        label: 'Test',
        fieldType: 'text'
      })).toThrow();
    });

    it('should validate all field types', () => {
      const validTypes = [
        'text', 'text_choice', 'text_multiline', 'richtext', 'numeric',
        'currency', 'percent', 'date', 'datetime', 'checkbox', 'email',
        'phone', 'url', 'address', 'file', 'lookup', 'formula', 'reference'
      ];

      validTypes.forEach(fieldType => {
        const data = {
          confirm: true,
          tableId: 'bux123',
          label: 'Test',
          fieldType
        };
        expect(CreateFieldSchema.parse(data)).toBeDefined();
      });
    });

    it('should reject invalid field type', () => {
      expect(() => CreateFieldSchema.parse({
        confirm: true,
        tableId: 'bux123',
        label: 'Test',
        fieldType: 'invalid_type'
      })).toThrow();
    });

    it('should validate choices array', () => {
      const data = {
        confirm: true,
        tableId: 'bux123',
        label: 'Status',
        fieldType: 'text_choice',
        choices: ['Option 1', 'Option 2', 'Option 3']
      };
      expect(CreateFieldSchema.parse(data).choices).toHaveLength(3);
    });

    it('should limit choices to 500 items', () => {
      const choices = Array.from({ length: 501 }, (_, i) => `Option ${i}`);
      expect(() => CreateFieldSchema.parse({
        confirm: true,
        tableId: 'bux123',
        label: 'Status',
        fieldType: 'text_choice',
        choices
      })).toThrow();
    });
  });

  describe('QueryRecordsSchema', () => {
    it('should validate query with tableId only', () => {
      const data = { tableId: 'bux123' };
      expect(QueryRecordsSchema.parse(data)).toEqual(data);
    });

    it('should validate query with filters', () => {
      const data = {
        tableId: 'bux123',
        where: '{4.EX."John"}',
        top: 100,
        skip: 0
      };
      expect(QueryRecordsSchema.parse(data)).toMatchObject(data);
    });

    it('should validate sortBy criteria', () => {
      const data = {
        tableId: 'bux123',
        sortBy: [
          { fieldId: 4, order: 'ASC' },
          { fieldId: 5, order: 'DESC' }
        ]
      };
      expect(QueryRecordsSchema.parse(data).sortBy).toHaveLength(2);
    });

    it('should enforce top limit of 1000', () => {
      expect(() => QueryRecordsSchema.parse({
        tableId: 'bux123',
        top: 1001
      })).toThrow();
    });

    it('should enforce skip minimum of 0', () => {
      expect(() => QueryRecordsSchema.parse({
        tableId: 'bux123',
        skip: -1
      })).toThrow();
    });

    it('should require tableId', () => {
      expect(() => QueryRecordsSchema.parse({})).toThrow();
    });
  });

  describe('CreateRecordSchema', () => {
    it('should validate record creation', () => {
      const data = {
        confirm: true,
        tableId: 'bux123',
        fields: {
          4: 'John Doe',
          5: 'john@example.com'
        }
      };
      expect(CreateRecordSchema.parse(data)).toMatchObject(data);
    });

    it('should validate with complex field types', () => {
      const data = {
        confirm: true,
        tableId: 'bux123',
        fields: {
          4: 'John',
          5: 123,
          6: true,
          7: ['Option 1', 'Option 2']
        }
      };
      expect(CreateRecordSchema.parse(data)).toBeDefined();
    });

    it('should require confirm: true', () => {
      expect(() => CreateRecordSchema.parse({
        tableId: 'bux123',
        fields: {}
      })).toThrow();
    });

    it('should require fields object', () => {
      expect(() => CreateRecordSchema.parse({
        confirm: true,
        tableId: 'bux123'
      })).toThrow();
    });
  });

  describe('UpdateRecordSchema', () => {
    it('should validate record update', () => {
      const data = {
        confirm: true,
        tableId: 'bux123',
        recordId: 42,
        fields: { 4: 'Jane Doe' }
      };
      expect(UpdateRecordSchema.parse(data)).toMatchObject(data);
    });

    it('should require recordId', () => {
      expect(() => UpdateRecordSchema.parse({
        confirm: true,
        tableId: 'bux123',
        fields: {}
      })).toThrow();
    });

    it('should require confirm: true', () => {
      expect(() => UpdateRecordSchema.parse({
        tableId: 'bux123',
        recordId: 42,
        fields: {}
      })).toThrow();
    });
  });

  describe('BulkCreateSchema', () => {
    it('should validate bulk record creation', () => {
      const data = {
        confirm: true,
        tableId: 'bux123',
        records: [
          { fields: { 4: 'John' } },
          { fields: { 4: 'Jane' } }
        ]
      };
      expect(BulkCreateSchema.parse(data)).toMatchObject(data);
    });

    it('should limit to 250 records', () => {
      const records = Array.from({ length: 251 }, () => ({ fields: { 4: 'Test' } }));
      expect(() => BulkCreateSchema.parse({
        confirm: true,
        tableId: 'bux123',
        records
      })).toThrow();
    });

    it('should allow up to 250 records', () => {
      const records = Array.from({ length: 250 }, () => ({ fields: { 4: 'Test' } }));
      const data = {
        confirm: true,
        tableId: 'bux123',
        records
      };
      expect(BulkCreateSchema.parse(data).records).toHaveLength(250);
    });
  });

  describe('SearchRecordsSchema', () => {
    it('should validate record search', () => {
      const data = {
        tableId: 'bux123',
        searchTerm: 'John'
      };
      expect(SearchRecordsSchema.parse(data)).toEqual(data);
    });

    it('should validate with fieldIds', () => {
      const data = {
        tableId: 'bux123',
        searchTerm: 'John',
        fieldIds: [4, 5, 6]
      };
      expect(SearchRecordsSchema.parse(data)).toMatchObject(data);
    });

    it('should require searchTerm with minimum length', () => {
      expect(() => SearchRecordsSchema.parse({
        tableId: 'bux123',
        searchTerm: ''
      })).toThrow();
    });

    it('should enforce searchTerm max length', () => {
      const longTerm = 'a'.repeat(201);
      expect(() => SearchRecordsSchema.parse({
        tableId: 'bux123',
        searchTerm: longTerm
      })).toThrow();
    });
  });

  describe('CreateRelationshipSchema', () => {
    it('should validate relationship creation', () => {
      const data = {
        confirm: true,
        parentTableId: 'bux123',
        childTableId: 'bux124',
        foreignKeyFieldId: 15
      };
      expect(CreateRelationshipSchema.parse(data)).toMatchObject(data);
    });

    it('should require confirm: true', () => {
      expect(() => CreateRelationshipSchema.parse({
        parentTableId: 'bux123',
        childTableId: 'bux124',
        foreignKeyFieldId: 15
      })).toThrow();
    });

    it('should require all table IDs', () => {
      expect(() => CreateRelationshipSchema.parse({
        confirm: true,
        parentTableId: 'bux123',
        childTableId: 'bux124'
      })).toThrow();
    });
  });

  describe('CreateAdvancedRelationshipSchema', () => {
    it('should validate advanced relationship', () => {
      const data = {
        confirm: true,
        parentTableId: 'bux123',
        childTableId: 'bux124',
        referenceFieldLabel: 'Parent Reference'
      };
      expect(CreateAdvancedRelationshipSchema.parse(data)).toMatchObject(data);
    });

    it('should validate with lookup fields', () => {
      const data = {
        confirm: true,
        parentTableId: 'bux123',
        childTableId: 'bux124',
        referenceFieldLabel: 'Parent Reference',
        lookupFields: [
          { parentFieldId: 4, childFieldLabel: 'Parent Name' }
        ]
      };
      expect(CreateAdvancedRelationshipSchema.parse(data)).toBeDefined();
    });

    it('should validate relationship type', () => {
      const oneToMany = {
        confirm: true,
        parentTableId: 'bux123',
        childTableId: 'bux124',
        referenceFieldLabel: 'Parent',
        relationshipType: 'one-to-many' as const
      };
      const manyToMany = {
        confirm: true,
        parentTableId: 'bux123',
        childTableId: 'bux124',
        referenceFieldLabel: 'Parent',
        relationshipType: 'many-to-many' as const
      };
      expect(CreateAdvancedRelationshipSchema.parse(oneToMany)).toBeDefined();
      expect(CreateAdvancedRelationshipSchema.parse(manyToMany)).toBeDefined();
    });
  });

  describe('CreateLookupFieldSchema', () => {
    it('should validate lookup field creation', () => {
      const data = {
        confirm: true,
        childTableId: 'bux124',
        parentTableId: 'bux123',
        referenceFieldId: 10,
        parentFieldId: 4,
        lookupFieldLabel: 'Parent Name'
      };
      expect(CreateLookupFieldSchema.parse(data)).toMatchObject(data);
    });

    it('should require all fields', () => {
      expect(() => CreateLookupFieldSchema.parse({
        confirm: true,
        childTableId: 'bux124',
        parentTableId: 'bux123',
        referenceFieldId: 10
      })).toThrow();
    });
  });

  describe('ValidateRelationshipSchema', () => {
    it('should validate relationship validation request', () => {
      const data = {
        parentTableId: 'bux123',
        childTableId: 'bux124',
        foreignKeyFieldId: 15
      };
      expect(ValidateRelationshipSchema.parse(data)).toMatchObject(data);
    });

    it('should require all fields', () => {
      expect(() => ValidateRelationshipSchema.parse({
        parentTableId: 'bux123',
        childTableId: 'bux124'
      })).toThrow();
    });
  });
});

describe('Tool Definitions', () => {
  describe('quickbaseTools', () => {
    it('should export tools array', () => {
      expect(Array.isArray(quickbaseTools)).toBe(true);
      expect(quickbaseTools.length).toBeGreaterThan(0);
    });

    it('should have required tool properties', () => {
      quickbaseTools.forEach(tool => {
        expect(tool.name).toBeDefined();
        expect(typeof tool.name).toBe('string');
        expect(tool.description).toBeDefined();
        expect(typeof tool.description).toBe('string');
        expect(tool.inputSchema).toBeDefined();
      });
    });

    it('should have app tools', () => {
      const appTools = quickbaseTools.filter(t => 
        t.name.includes('app') || t.name.includes('connection')
      );
      expect(appTools.length).toBeGreaterThan(0);
    });

    it('should have table tools', () => {
      const tableTools = quickbaseTools.filter(t => 
        t.name.includes('table')
      );
      expect(tableTools.length).toBeGreaterThan(0);
    });

    it('should have field tools', () => {
      const fieldTools = quickbaseTools.filter(t => 
        t.name.includes('field')
      );
      expect(fieldTools.length).toBeGreaterThan(0);
    });

    it('should have record tools', () => {
      const recordTools = quickbaseTools.filter(t => 
        t.name.includes('record')
      );
      expect(recordTools.length).toBeGreaterThan(0);
    });

    it('should have relationship tools', () => {
      const relationshipTools = quickbaseTools.filter(t => 
        t.name.includes('relationship')
      );
      expect(relationshipTools.length).toBeGreaterThan(0);
    });

    it('should have unique tool names', () => {
      const names = quickbaseTools.map(t => t.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });

    it('should have valid input schemas', () => {
      quickbaseTools.forEach(tool => {
        expect(tool.inputSchema).toBeDefined();
        expect(typeof tool.inputSchema).toBe('object');
        if (tool.inputSchema && 'type' in tool.inputSchema) {
          expect(tool.inputSchema.type).toBe('object');
        }
      });
    });
  });

  describe('Tool Coverage', () => {
    it('should include query_records tool', () => {
      const tool = quickbaseTools.find(t => t.name === 'quickbase_query_records');
      expect(tool).toBeDefined();
    });

    it('should include create_record tool', () => {
      const tool = quickbaseTools.find(t => t.name === 'quickbase_create_record');
      expect(tool).toBeDefined();
    });

    it('should include update_record tool', () => {
      const tool = quickbaseTools.find(t => t.name === 'quickbase_update_record');
      expect(tool).toBeDefined();
    });

    it('should include delete_record tool', () => {
      const tool = quickbaseTools.find(t => t.name === 'quickbase_delete_record');
      expect(tool).toBeDefined();
    });

    it('should include bulk_create_records tool', () => {
      const tool = quickbaseTools.find(t => t.name === 'quickbase_bulk_create_records');
      expect(tool).toBeDefined();
    });
  });

  describe('Webhook Schemas', () => {
    describe('CreateWebhookSchema', () => {
      it('should validate webhook creation with required fields', () => {
        const data = {
          confirm: true,
          tableId: 'bux123',
          label: 'My Webhook',
          webhookUrl: 'https://example.com/webhook',
          webhookEvents: 'amd'
        };
        expect(CreateWebhookSchema.parse(data)).toEqual(data);
      });

      it('should require confirm: true', () => {
        expect(() =>
          CreateWebhookSchema.parse({
            tableId: 'bux123',
            label: 'My Webhook',
            webhookUrl: 'https://example.com/webhook',
            webhookEvents: 'amd'
          })
        ).toThrow();
      });

      it('should validate webhook events (a, d, m combinations)', () => {
        const validCombos = ['a', 'd', 'm', 'ad', 'am', 'dm', 'adm', 'mda'];
        validCombos.forEach(combo => {
          expect(
            CreateWebhookSchema.parse({
              confirm: true,
              tableId: 'bux123',
              label: 'Webhook',
              webhookUrl: 'https://example.com/webhook',
              webhookEvents: combo
            })
          ).toBeDefined();
        });
      });

      it('should reject invalid webhook events', () => {
        expect(() =>
          CreateWebhookSchema.parse({
            confirm: true,
            tableId: 'bux123',
            label: 'Webhook',
            webhookUrl: 'https://example.com/webhook',
            webhookEvents: 'xyz'
          })
        ).toThrow();
      });

      it('should validate with optional parameters', () => {
        const data = {
          confirm: true,
          tableId: 'bux123',
          label: 'My Webhook',
          webhookUrl: 'https://example.com/webhook',
          webhookEvents: 'amd',
          description: 'Test webhook',
          messageFormat: 'JSON',
          messageBody: '{"test": true}',
          webhookHeaders: { 'Authorization': 'Bearer token' },
          httpMethod: 'POST',
          triggerFields: [6, 7, 8]
        };
        expect(CreateWebhookSchema.parse(data)).toEqual(data);
      });

      it('should reject invalid URL format', () => {
        expect(() =>
          CreateWebhookSchema.parse({
            confirm: true,
            tableId: 'bux123',
            label: 'Webhook',
            webhookUrl: 'not-a-url',
            webhookEvents: 'a'
          })
        ).toThrow();
      });
    });

    describe('ListWebhooksSchema', () => {
      it('should validate listing webhooks', () => {
        const data = { tableId: 'bux123' };
        expect(ListWebhooksSchema.parse(data)).toEqual(data);
      });

      it('should require tableId', () => {
        expect(() => ListWebhooksSchema.parse({})).toThrow();
      });
    });

    describe('DeleteWebhookSchema', () => {
      it('should validate webhook deletion', () => {
        const data = { tableId: 'bux123', webhookId: 'webhook456' };
        expect(DeleteWebhookSchema.parse(data)).toEqual(data);
      });

      it('should require both tableId and webhookId', () => {
        expect(() => DeleteWebhookSchema.parse({ tableId: 'bux123' })).toThrow();
        expect(() => DeleteWebhookSchema.parse({ webhookId: 'webhook456' })).toThrow();
      });
    });

    describe('TestWebhookSchema', () => {
      it('should validate webhook testing', () => {
        const data = {
          webhookUrl: 'https://example.com/webhook',
          testPayload: { recordId: 123, event: 'add' }
        };
        expect(TestWebhookSchema.parse(data)).toEqual(data);
      });

      it('should allow optional headers', () => {
        const data = {
          webhookUrl: 'https://example.com/webhook',
          testPayload: { test: true },
          headers: { 'X-Custom': 'value' }
        };
        expect(TestWebhookSchema.parse(data)).toEqual(data);
      });

      it('should require webhookUrl and testPayload', () => {
        expect(() =>
          TestWebhookSchema.parse({ testPayload: { test: true } })
        ).toThrow();
        expect(() =>
          TestWebhookSchema.parse({ webhookUrl: 'https://example.com' })
        ).toThrow();
      });
    });
  });

  describe('Notification Schemas', () => {
    describe('CreateNotificationSchema', () => {
      it('should validate notification creation with required fields', () => {
        const data = {
          confirm: true,
          tableId: 'bux123',
          label: 'Email Alert',
          notificationEvent: 'add',
          recipientEmail: 'user@example.com',
          messageSubject: 'New Record Added',
          messageBody: 'A new record was added to the table.'
        };
        expect(CreateNotificationSchema.parse(data)).toEqual(data);
      });

      it('should require confirm: true', () => {
        expect(() =>
          CreateNotificationSchema.parse({
            tableId: 'bux123',
            label: 'Email Alert',
            notificationEvent: 'add',
            recipientEmail: 'user@example.com',
            messageSubject: 'New Record',
            messageBody: 'Body'
          })
        ).toThrow();
      });

      it('should validate notification event types', () => {
        const events = ['add', 'modify', 'delete'];
        events.forEach(event => {
          expect(
            CreateNotificationSchema.parse({
              confirm: true,
              tableId: 'bux123',
              label: 'Alert',
              notificationEvent: event,
              recipientEmail: 'user@example.com',
              messageSubject: 'Subject',
              messageBody: 'Body'
            })
          ).toBeDefined();
        });
      });

      it('should reject invalid notification event types', () => {
        expect(() =>
          CreateNotificationSchema.parse({
            confirm: true,
            tableId: 'bux123',
            label: 'Alert',
            notificationEvent: 'invalid',
            recipientEmail: 'user@example.com',
            messageSubject: 'Subject',
            messageBody: 'Body'
          })
        ).toThrow();
      });

      it('should validate email format', () => {
        expect(() =>
          CreateNotificationSchema.parse({
            confirm: true,
            tableId: 'bux123',
            label: 'Alert',
            notificationEvent: 'add',
            recipientEmail: 'not-an-email',
            messageSubject: 'Subject',
            messageBody: 'Body'
          })
        ).toThrow();
      });

      it('should validate with optional parameters', () => {
        const data = {
          confirm: true,
          tableId: 'bux123',
          label: 'Email Alert',
          description: 'Alert for new records',
          notificationEvent: 'add',
          recipientEmail: 'user@example.com',
          messageSubject: 'New Record Added',
          messageBody: 'A new record was added.',
          includeAllFields: true,
          triggerFields: [6, 7]
        };
        expect(CreateNotificationSchema.parse(data)).toEqual(data);
      });
    });

    describe('ListNotificationsSchema', () => {
      it('should validate listing notifications', () => {
        const data = { tableId: 'bux123' };
        expect(ListNotificationsSchema.parse(data)).toEqual(data);
      });

      it('should require tableId', () => {
        expect(() => ListNotificationsSchema.parse({})).toThrow();
      });
    });

    describe('DeleteNotificationSchema', () => {
      it('should validate notification deletion', () => {
        const data = { tableId: 'bux123', notificationId: 'notif789' };
        expect(DeleteNotificationSchema.parse(data)).toEqual(data);
      });

      it('should require both tableId and notificationId', () => {
        expect(() => DeleteNotificationSchema.parse({ tableId: 'bux123' })).toThrow();
        expect(() => DeleteNotificationSchema.parse({ notificationId: 'notif789' })).toThrow();
      });
    });
  });

  describe('Tool Definitions - Webhooks and Notifications', () => {
    it('should include create_webhook tool', () => {
      const tool = quickbaseTools.find(t => t.name === 'quickbase_create_webhook');
      expect(tool).toBeDefined();
      expect(tool?.description).toContain('webhook');
    });

    it('should include list_webhooks tool', () => {
      const tool = quickbaseTools.find(t => t.name === 'quickbase_list_webhooks');
      expect(tool).toBeDefined();
    });

    it('should include delete_webhook tool', () => {
      const tool = quickbaseTools.find(t => t.name === 'quickbase_delete_webhook');
      expect(tool).toBeDefined();
    });

    it('should include test_webhook tool', () => {
      const tool = quickbaseTools.find(t => t.name === 'quickbase_test_webhook');
      expect(tool).toBeDefined();
    });

    it('should include create_notification tool', () => {
      const tool = quickbaseTools.find(t => t.name === 'quickbase_create_notification');
      expect(tool).toBeDefined();
      expect(tool?.description).toContain('notification');
    });

    it('should include list_notifications tool', () => {
      const tool = quickbaseTools.find(t => t.name === 'quickbase_list_notifications');
      expect(tool).toBeDefined();
    });

    it('should include delete_notification tool', () => {
      const tool = quickbaseTools.find(t => t.name === 'quickbase_delete_notification');
      expect(tool).toBeDefined();
    });

    it('create_webhook should require confirm parameter', () => {
      const tool = quickbaseTools.find(t => t.name === 'quickbase_create_webhook');
      const required = (tool?.inputSchema as any).required || [];
      expect(required).toContain('confirm');
    });

    it('create_notification should require confirm parameter', () => {
      const tool = quickbaseTools.find(t => t.name === 'quickbase_create_notification');
      const required = (tool?.inputSchema as any).required || [];
      expect(required).toContain('confirm');
    });
  });
});
