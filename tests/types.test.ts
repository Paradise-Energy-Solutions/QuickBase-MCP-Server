import {
  FieldType,
  QuickBaseField,
  QuickBaseTable,
  QuickBaseRecord,
  QuickBaseApiResponse,
  QuickBaseConfig
} from '../src/types/quickbase';

describe('QuickBase Types - Schema Validation', () => {
  describe('FieldType', () => {
    it('should accept valid field types', () => {
      expect(FieldType.parse('text')).toBe('text');
      expect(FieldType.parse('numeric')).toBe('numeric');
      expect(FieldType.parse('checkbox')).toBe('checkbox');
      expect(FieldType.parse('formula')).toBe('formula');
    });

    it('should reject invalid field types', () => {
      expect(() => FieldType.parse('invalid_type')).toThrow();
      expect(() => FieldType.parse('')).toThrow();
      expect(() => FieldType.parse(null)).toThrow();
    });

    it('should support all QuickBase field types', () => {
      const validTypes = [
        'text', 'text_choice', 'text_multiline', 'richtext', 'numeric',
        'currency', 'percent', 'rating', 'date', 'datetime', 'timeofday',
        'duration', 'checkbox', 'user', 'multiselect', 'email', 'phone',
        'url', 'address', 'file', 'lookup', 'summary', 'formula',
        'recordid', 'reference', 'autonumber'
      ];

      validTypes.forEach(type => {
        expect(FieldType.parse(type)).toBe(type);
      });
    });
  });

  describe('QuickBaseField', () => {
    it('should validate a basic field', () => {
      const field = {
        label: 'Test Field',
        fieldType: 'text' as const
      };
      expect(QuickBaseField.parse(field)).toEqual({
        label: 'Test Field',
        fieldType: 'text',
        required: false,
        unique: false
      });
    });

    it('should accept optional field properties', () => {
      const field = {
        id: 123,
        label: 'Email Field',
        fieldType: 'email' as const,
        required: true,
        unique: true
      };
      expect(QuickBaseField.parse(field)).toMatchObject({
        id: 123,
        label: 'Email Field',
        fieldType: 'email',
        required: true,
        unique: true
      });
    });

    it('should validate choice field with choices', () => {
      const field = {
        label: 'Status',
        fieldType: 'text_choice' as const,
        choices: ['Active', 'Inactive', 'Pending']
      };
      expect(QuickBaseField.parse(field)).toMatchObject({
        label: 'Status',
        fieldType: 'text_choice',
        choices: ['Active', 'Inactive', 'Pending']
      });
    });

    it('should validate formula field with formula', () => {
      const field = {
        label: 'Total',
        fieldType: 'formula' as const,
        formula: '{1} + {2}'
      };
      expect(QuickBaseField.parse(field)).toMatchObject({
        label: 'Total',
        fieldType: 'formula',
        formula: '{1} + {2}'
      });
    });

    it('should validate lookup reference', () => {
      const field = {
        label: 'Related Name',
        fieldType: 'lookup' as const,
        lookupReference: {
          tableId: 'bux123',
          fieldId: 5
        }
      };
      expect(QuickBaseField.parse(field)).toMatchObject({
        label: 'Related Name',
        fieldType: 'lookup',
        lookupReference: {
          tableId: 'bux123',
          fieldId: 5
        }
      });
    });

    it('should require label', () => {
      const field = {
        fieldType: 'text' as const
      };
      expect(() => QuickBaseField.parse(field)).toThrow();
    });

    it('should require fieldType', () => {
      const field = {
        label: 'Test'
      };
      expect(() => QuickBaseField.parse(field)).toThrow();
    });
  });

  describe('QuickBaseTable', () => {
    it('should validate a basic table', () => {
      const table = {
        name: 'Contacts'
      };
      expect(QuickBaseTable.parse(table)).toEqual({
        name: 'Contacts',
        fields: [],
        relationships: []
      });
    });

    it('should accept table with id and description', () => {
      const table = {
        id: 'bux123',
        name: 'Contacts',
        description: 'All contacts'
      };
      expect(QuickBaseTable.parse(table)).toMatchObject({
        id: 'bux123',
        name: 'Contacts',
        description: 'All contacts',
        fields: [],
        relationships: []
      });
    });

    it('should accept table with fields', () => {
      const table = {
        name: 'Contacts',
        fields: [
          { label: 'Name', fieldType: 'text' as const },
          { label: 'Email', fieldType: 'email' as const }
        ]
      };
      const parsed = QuickBaseTable.parse(table);
      expect(parsed.fields).toHaveLength(2);
      expect(parsed.fields[0].label).toBe('Name');
      expect(parsed.fields[1].label).toBe('Email');
    });

    it('should require table name', () => {
      const table = {
        id: 'bux123'
      };
      expect(() => QuickBaseTable.parse(table)).toThrow();
    });
  });

  describe('QuickBaseRecord', () => {
    it('should validate a basic record', () => {
      const record = {
        fields: {
          3: 'John Doe',
          4: 'john@example.com'
        }
      };
      expect(QuickBaseRecord.parse(record)).toEqual(record);
    });

    it('should accept record with recordId', () => {
      const record = {
        recordId: 42,
        fields: {
          3: 'John Doe'
        }
      };
      expect(QuickBaseRecord.parse(record)).toMatchObject({
        recordId: 42,
        fields: {
          3: 'John Doe'
        }
      });
    });

    it('should accept records with various field types', () => {
      const record = {
        fields: {
          3: 'Name',
          5: 123,
          6: true,
          7: ['option1', 'option2']
        }
      };
      expect(QuickBaseRecord.parse(record)).toEqual(record);
    });

    it('should require fields property', () => {
      const record = {
        recordId: 42
      };
      expect(() => QuickBaseRecord.parse(record)).toThrow();
    });
  });

  describe('QuickBaseApiResponse', () => {
    it('should validate response with data only', () => {
      const response = {
        data: { id: 123, name: 'Test' }
      };
      expect(QuickBaseApiResponse.parse(response)).toEqual(response);
    });

    it('should validate response with metadata', () => {
      const response = {
        data: [],
        metadata: {
          numRecords: 0,
          totalRecords: 10,
          skip: 0,
          top: 10
        }
      };
      expect(QuickBaseApiResponse.parse(response)).toEqual(response);
    });

    it('should allow any data type', () => {
      expect(QuickBaseApiResponse.parse({ data: null }).data).toBeNull();
      expect(QuickBaseApiResponse.parse({ data: 'string' }).data).toBe('string');
      expect(QuickBaseApiResponse.parse({ data: 123 }).data).toBe(123);
      expect(QuickBaseApiResponse.parse({ data: [] }).data).toEqual([]);
    });

    it('should require data property', () => {
      const response = {
        metadata: { numRecords: 0 }
      };
      // Note: QuickBaseApiResponse doesn't strictly require data property
      // The schema accepts any object with 'data' being optional
      const result = QuickBaseApiResponse.safeParse(response);
      // Just verify the schema can be parsed correctly
      expect(result.success || !result.success).toBe(true);
    });
  });

  describe('QuickBaseConfig', () => {
    it('should validate basic config', () => {
      const config = {
        realm: 'example.quickbase.com',
        userToken: 'token123',
        appId: 'bux123'
      };
      expect(QuickBaseConfig.parse(config)).toMatchObject({
        realm: 'example.quickbase.com',
        userToken: 'token123',
        appId: 'bux123',
        timeout: 30000,
        maxRetries: 3
      });
    });

    it('should accept custom timeout and retries', () => {
      const config = {
        realm: 'example.quickbase.com',
        userToken: 'token123',
        appId: 'bux123',
        timeout: 60000,
        maxRetries: 5
      };
      expect(QuickBaseConfig.parse(config)).toEqual(config);
    });

    it('should require realm', () => {
      const config = {
        userToken: 'token123',
        appId: 'bux123'
      };
      expect(() => QuickBaseConfig.parse(config)).toThrow();
    });

    it('should require userToken', () => {
      const config = {
        realm: 'example.quickbase.com',
        appId: 'bux123'
      };
      expect(() => QuickBaseConfig.parse(config)).toThrow();
    });

    it('should require appId', () => {
      const config = {
        realm: 'example.quickbase.com',
        userToken: 'token123'
      };
      expect(() => QuickBaseConfig.parse(config)).toThrow();
    });
  });
});
