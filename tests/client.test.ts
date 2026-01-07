import { QuickBaseClient } from '../src/quickbase/client';
import { QuickBaseConfig, QuickBaseField, QuickBaseRecord } from '../src/types/quickbase';
import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('QuickBaseClient', () => {
  let client: QuickBaseClient;
  let mockAxiosInstance: any;
  const mockConfig: QuickBaseConfig = {
    realm: 'example.quickbase.com',
    userToken: 'token123',
    appId: 'bux123',
    timeout: 30000,
    maxRetries: 3
  };

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockAxiosInstance = {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
      interceptors: {
        request: {
          use: jest.fn((success, error) => {})
        },
        response: {
          use: jest.fn((success, error) => {})
        }
      }
    };

    mockedAxios.create.mockReturnValue(mockAxiosInstance);
    client = new QuickBaseClient(mockConfig);
  });

  describe('Constructor', () => {
    it('should create client with valid config', () => {
      expect(client).toBeDefined();
    });

    it('should set up axios with correct base URL and headers', () => {
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://api.quickbase.com/v1',
          timeout: 30000,
          headers: expect.objectContaining({
            'QB-Realm-Hostname': 'example.quickbase.com',
            'User-Agent': 'QuickBase-MCP-Server/1.0.0',
            'Authorization': 'QB-USER-TOKEN token123',
            'Content-Type': 'application/json'
          })
        })
      );
    });

    it('should set up request and response interceptors', () => {
      expect(mockAxiosInstance.interceptors.request.use).toHaveBeenCalled();
      expect(mockAxiosInstance.interceptors.response.use).toHaveBeenCalled();
    });
  });

  describe('Application Methods', () => {
    describe('getAppInfo', () => {
      it('should fetch app info', async () => {
        const mockResponse = { id: 'bux123', name: 'Test App' };
        mockAxiosInstance.get.mockResolvedValue({ data: mockResponse });

        const result = await client.getAppInfo();

        expect(mockAxiosInstance.get).toHaveBeenCalledWith('/apps/bux123');
        expect(result).toEqual(mockResponse);
      });

      it('should handle errors when fetching app info', async () => {
        const error = new Error('Network error');
        mockAxiosInstance.get.mockRejectedValue(error);

        await expect(client.getAppInfo()).rejects.toThrow('Network error');
      });
    });

    describe('getAppTables', () => {
      it('should fetch all tables in app', async () => {
        const mockTables = [
          { id: 'bux123', name: 'Contacts' },
          { id: 'bux124', name: 'Companies' }
        ];
        mockAxiosInstance.get.mockResolvedValue({ data: mockTables });

        const result = await client.getAppTables();

        expect(mockAxiosInstance.get).toHaveBeenCalledWith('/tables', {
          params: { appId: 'bux123' }
        });
        expect(result).toEqual(mockTables);
        expect(result).toHaveLength(2);
      });
    });
  });

  describe('Table Methods', () => {
    describe('createTable', () => {
      it('should create a table with name only', async () => {
        mockAxiosInstance.post.mockResolvedValue({ data: { id: 'bux999' } });

        const result = await client.createTable({ name: 'NewTable' });

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/tables',
          expect.objectContaining({
            appId: 'bux123',
            name: 'NewTable',
            pluralRecordName: 'NewTable'
          })
        );
        expect(result).toBe('bux999');
      });

      it('should create table with description', async () => {
        mockAxiosInstance.post.mockResolvedValue({ data: { id: 'bux999' } });

        await client.createTable({
          name: 'Contacts',
          description: 'All contacts'
        });

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/tables',
          expect.objectContaining({
            name: 'Contacts',
            description: 'All contacts'
          })
        );
      });
    });

    describe('getTableInfo', () => {
      it('should fetch table information', async () => {
        const mockTable = { id: 'bux123', name: 'Contacts' };
        mockAxiosInstance.get.mockResolvedValue({ data: mockTable });

        const result = await client.getTableInfo('bux123');

        expect(mockAxiosInstance.get).toHaveBeenCalledWith(
          '/tables/bux123',
          { params: { appId: 'bux123' } }
        );
        expect(result).toEqual(mockTable);
      });
    });

    describe('updateTable', () => {
      it('should update table', async () => {
        mockAxiosInstance.post.mockResolvedValue({});

        await client.updateTable('bux123', { name: 'UpdatedContacts' });

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/tables/bux123',
          expect.objectContaining({
            appId: 'bux123',
            name: 'UpdatedContacts'
          })
        );
      });
    });

    describe('deleteTable', () => {
      it('should delete table', async () => {
        mockAxiosInstance.delete.mockResolvedValue({});

        await client.deleteTable('bux123');

        expect(mockAxiosInstance.delete).toHaveBeenCalledWith(
          '/tables/bux123',
          { params: { appId: 'bux123' } }
        );
      });
    });
  });

  describe('Field Methods', () => {
    describe('getTableFields', () => {
      it('should fetch all fields in a table', async () => {
        const mockFields = [
          { id: 1, label: 'Record ID', fieldType: 'recordid' },
          { id: 2, label: 'Name', fieldType: 'text' }
        ];
        mockAxiosInstance.get.mockResolvedValue({ data: mockFields });

        const result = await client.getTableFields('bux123');

        expect(mockAxiosInstance.get).toHaveBeenCalledWith(
          '/fields',
          { params: { tableId: 'bux123' } }
        );
        expect(result).toEqual(mockFields);
      });
    });

    describe('createField', () => {
      it('should create a basic text field', async () => {
        mockAxiosInstance.post.mockResolvedValue({ data: { id: 42 } });

        const field: QuickBaseField = {
          label: 'Email',
          fieldType: 'email',
          required: false,
          unique: false
        };

        const result = await client.createField('bux123', field);

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/fields',
          expect.objectContaining({
            tableId: 'bux123',
            label: 'Email',
            fieldType: 'email',
            required: false,
            unique: false
          })
        );
        expect(result).toBe(42);
      });

      it('should create a choice field with choices', async () => {
        mockAxiosInstance.post.mockResolvedValue({ data: { id: 43 } });

        const field: QuickBaseField = {
          label: 'Status',
          fieldType: 'text_choice',
          required: false,
          unique: false,
          choices: ['Active', 'Inactive']
        };

        await client.createField('bux123', field);

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/fields',
          expect.objectContaining({
            label: 'Status',
            fieldType: 'text_choice',
            properties: { choices: ['Active', 'Inactive'] }
          })
        );
      });

      it('should create a formula field', async () => {
        mockAxiosInstance.post.mockResolvedValue({ data: { id: 44 } });

        const field: QuickBaseField = {
          label: 'Total',
          fieldType: 'formula',
          required: false,
          unique: false,
          formula: '{1} + {2}'
        };

        await client.createField('bux123', field);

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/fields',
          expect.objectContaining({
            label: 'Total',
            fieldType: 'formula',
            formula: '{1} + {2}'
          })
        );
      });
    });

    describe('updateField', () => {
      it('should update a field', async () => {
        mockAxiosInstance.post.mockResolvedValue({});

        await client.updateField('bux123', 42, { label: 'UpdatedEmail' });

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/fields/42',
          expect.objectContaining({
            tableId: 'bux123',
            label: 'UpdatedEmail'
          })
        );
      });
    });

    describe('deleteField', () => {
      it('should delete a field', async () => {
        mockAxiosInstance.delete.mockResolvedValue({});

        await client.deleteField('bux123', 42);

        expect(mockAxiosInstance.delete).toHaveBeenCalledWith(
          '/fields/42',
          { params: { tableId: 'bux123' } }
        );
      });
    });
  });

  describe('Record Methods', () => {
    describe('getRecords', () => {
      it('should fetch records without options', async () => {
        const mockRecords = [
          { 3: { value: 1 }, 4: { value: 'John' } }
        ];
        mockAxiosInstance.post.mockResolvedValue({ data: { data: mockRecords } });

        const result = await client.getRecords('bux123');

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/records/query',
          { from: 'bux123' }
        );
        expect(result).toEqual(mockRecords);
      });

      it('should fetch records with query options', async () => {
        mockAxiosInstance.post.mockResolvedValue({ data: { data: [] } });

        await client.getRecords('bux123', {
          where: '{4.EX."John"}',
          top: 10
        });

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/records/query',
          expect.objectContaining({
            from: 'bux123',
            where: '{4.EX."John"}',
            top: 10
          })
        );
      });
    });

    describe('getRecord', () => {
      it('should fetch a single record by ID', async () => {
        const mockRecord = { 3: { value: 42 }, 4: { value: 'John' } };
        mockAxiosInstance.post.mockResolvedValue({ data: { data: [mockRecord] } });

        const result = await client.getRecord('bux123', 42);

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/records/query',
          expect.objectContaining({
            from: 'bux123',
            where: '{3.EX.42}'
          })
        );
        expect(result).toEqual(mockRecord);
      });

      it('should return null if record not found', async () => {
        mockAxiosInstance.post.mockResolvedValue({ data: { data: [] } });

        const result = await client.getRecord('bux123', 999);

        expect(result).toBeNull();
      });
    });

    describe('createRecord', () => {
      it('should create a single record', async () => {
        mockAxiosInstance.post.mockResolvedValue({
          data: { data: [{ '3': { value: 42 } }] }
        });

        const record: QuickBaseRecord = {
          fields: {
            4: 'John',
            5: 'john@example.com'
          }
        };

        const result = await client.createRecord('bux123', record);

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/records',
          expect.objectContaining({
            to: 'bux123',
            data: [record.fields]
          })
        );
        expect(result).toBe(42);
      });

      it('should create a record when IDs are returned in metadata', async () => {
        mockAxiosInstance.post.mockResolvedValue({
          data: { metadata: { createdRecordIds: [42] }, data: [] }
        });

        const record: QuickBaseRecord = {
          fields: {
            4: 'John',
            5: 'john@example.com'
          }
        };

        const result = await client.createRecord('bux123', record);
        expect(result).toBe(42);
      });

      it('should return null when no Record ID is returned', async () => {
        mockAxiosInstance.post.mockResolvedValue({
          data: { data: [], metadata: {} }
        });

        const record: QuickBaseRecord = {
          fields: { 4: 'John' }
        };

        const result = await client.createRecord('bux123', record);
        expect(result).toBeNull();
      });
    });

    describe('createRecords', () => {
      it('should create multiple records', async () => {
        mockAxiosInstance.post.mockResolvedValue({
          data: { data: [
            { '3': { value: 42 } },
            { '3': { value: 43 } }
          ] }
        });

        const records: QuickBaseRecord[] = [
          { fields: { 4: 'John' } },
          { fields: { 4: 'Jane' } }
        ];

        const result = await client.createRecords('bux123', records);

        expect(result).toEqual([42, 43]);
      });

      it('should create multiple records when IDs are returned in metadata', async () => {
        mockAxiosInstance.post.mockResolvedValue({
          data: { metadata: { createdRecordIds: [42, 43] }, data: [] }
        });

        const records: QuickBaseRecord[] = [
          { fields: { 4: 'John' } },
          { fields: { 4: 'Jane' } }
        ];

        const result = await client.createRecords('bux123', records);
        expect(result).toEqual([42, 43]);
      });

      it('should return an empty array when no Record IDs are returned', async () => {
        mockAxiosInstance.post.mockResolvedValue({
          data: { data: [], metadata: {} }
        });

        const records: QuickBaseRecord[] = [
          { fields: { 4: 'John' } },
          { fields: { 4: 'Jane' } }
        ];

        const result = await client.createRecords('bux123', records);
        expect(result).toEqual([]);
      });
    });

    describe('updateRecord', () => {
      it('should update a single record', async () => {
        mockAxiosInstance.post.mockResolvedValue({});

        await client.updateRecord('bux123', 42, { 4: 'Jane' });

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/records',
          expect.objectContaining({
            to: 'bux123',
            data: [expect.objectContaining({
              '3': { value: 42 },
              4: 'Jane'
            })]
          })
        );
      });
    });

    describe('updateRecords', () => {
      it('should update multiple records', async () => {
        mockAxiosInstance.post.mockResolvedValue({});

        await client.updateRecords('bux123', [
          { recordId: 42, updates: { 4: 'Jane' } },
          { recordId: 43, updates: { 4: 'John' } }
        ]);

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/records',
          expect.objectContaining({
            to: 'bux123',
            data: expect.arrayContaining([
              expect.objectContaining({ '3': { value: 42 } }),
              expect.objectContaining({ '3': { value: 43 } })
            ])
          })
        );
      });
    });

    describe('deleteRecord', () => {
      it('should delete a single record', async () => {
        mockAxiosInstance.delete.mockResolvedValue({});

        await client.deleteRecord('bux123', 42);

        expect(mockAxiosInstance.delete).toHaveBeenCalledWith(
          '/records',
          expect.objectContaining({
            data: {
              from: 'bux123',
              where: '{3.EX.42}'
            }
          })
        );
      });
    });

    describe('deleteRecords', () => {
      it('should delete multiple records', async () => {
        mockAxiosInstance.delete.mockResolvedValue({});

        await client.deleteRecords('bux123', [42, 43, 44]);

        expect(mockAxiosInstance.delete).toHaveBeenCalledWith(
          '/records',
          expect.objectContaining({
            data: {
              from: 'bux123',
              where: '{3.EX.42}OR{3.EX.43}OR{3.EX.44}'
            }
          })
        );
      });
    });
  });

  describe('Relationship Methods', () => {
    describe('createRelationship', () => {
      it('should create a relationship', async () => {
        mockAxiosInstance.post.mockResolvedValue({});

        await client.createRelationship('bux123', 'bux124', 15);

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/relationships',
          {
            parentTableId: 'bux123',
            childTableId: 'bux124',
            foreignKeyFieldId: 15
          }
        );
      });
    });

    describe('getRelationships', () => {
      it('should fetch relationships for a table', async () => {
        const mockRelationships = [
          { parentTableId: 'bux123', childTableId: 'bux124' }
        ];
        mockAxiosInstance.get.mockResolvedValue({ data: mockRelationships });

        const result = await client.getRelationships('bux124');

        expect(mockAxiosInstance.get).toHaveBeenCalledWith(
          '/relationships',
          { params: { childTableId: 'bux124' } }
        );
        expect(result).toEqual(mockRelationships);
      });
    });
  });
});
