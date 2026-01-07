import { QuickBaseClient } from '../src/quickbase/client';
import { QuickBaseConfig } from '../src/types/quickbase';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('QuickBaseClient - Advanced Methods', () => {
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

  describe('Advanced Relationship Methods', () => {
    describe('createAdvancedRelationship', () => {
      it('should create advanced relationship with lookup fields', async () => {
        mockAxiosInstance.post
          .mockResolvedValueOnce({ data: { id: 10 } })
          .mockResolvedValueOnce({ data: {} })
          .mockResolvedValueOnce({ data: { id: 11 } });

        const result = await client.createAdvancedRelationship(
          'bux123',
          'bux124',
          'Company Reference',
          [{ parentFieldId: 4, childFieldLabel: 'Company Name' }]
        );

        expect(result).toBeDefined();
        expect(result.referenceFieldId).toBe(10);
        expect(result.lookupFieldIds).toContain(11);
      });

      it('should create one-to-many relationship', async () => {
        mockAxiosInstance.post
          .mockResolvedValueOnce({ data: { id: 10 } })
          .mockResolvedValueOnce({ data: {} });

        const result = await client.createAdvancedRelationship(
          'bux123',
          'bux124',
          'Parent',
          [],
          'one-to-many'
        );

        expect(result.referenceFieldId).toBe(10);
        expect(result.lookupFieldIds).toEqual([]);
      });

      it('should create many-to-many relationship', async () => {
        mockAxiosInstance.post
          .mockResolvedValueOnce({ data: { id: 10 } })
          .mockResolvedValueOnce({ data: {} });

        const result = await client.createAdvancedRelationship(
          'bux123',
          'bux124',
          'Parent',
          [],
          'many-to-many'
        );

        expect(result.referenceFieldId).toBe(10);
      });
    });

    describe('createLookupField', () => {
      it('should create lookup field', async () => {
        mockAxiosInstance.post.mockResolvedValue({ data: { id: 12 } });

        const result = await client.createLookupField(
          'bux124',
          'bux123',
          10,
          4,
          'Company Name'
        );

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/fields',
          expect.objectContaining({
            tableId: 'bux124',
            label: 'Company Name',
            fieldType: 'lookup'
          })
        );
        expect(result).toBe(12);
      });
    });


    describe('createJunctionTable', () => {
      it('should create junction table for many-to-many relationship', async () => {
        mockAxiosInstance.post
          .mockResolvedValueOnce({ data: { id: 'bux125' } })
          .mockResolvedValueOnce({ data: { id: 20 } })
          .mockResolvedValueOnce({ data: { id: 21 } })
          .mockResolvedValueOnce({ data: {} })
          .mockResolvedValueOnce({ data: {} });

        const result = await client.createJunctionTable(
          'JunctionTable',
          'bux123',
          'bux124',
          'Parent Reference',
          'Child Reference'
        );

        expect(result).toBeDefined();
        expect(result.junctionTableId).toBe('bux125');
        expect(result.table1ReferenceFieldId).toBe(20);
        expect(result.table2ReferenceFieldId).toBe(21);
      });

      it('should create junction table with additional fields', async () => {
        mockAxiosInstance.post
          .mockResolvedValueOnce({ data: { id: 'bux125' } })
          .mockResolvedValueOnce({ data: { id: 20 } })
          .mockResolvedValueOnce({ data: { id: 21 } })
          .mockResolvedValueOnce({ data: {} })
          .mockResolvedValueOnce({ data: {} })
          .mockResolvedValueOnce({ data: { id: 22 } });

        const result = await client.createJunctionTable(
          'JunctionTable',
          'bux123',
          'bux124',
          'Parent Ref',
          'Child Ref',
          [{ label: 'Quantity', fieldType: 'numeric' }]
        );

        expect(result).toBeDefined();
        expect(result.junctionTableId).toBe('bux125');
      });
    });
  });

  describe('Utility Methods', () => {
    describe('getReports', () => {
      it('should get all reports for a table', async () => {
        const reports = [
          { id: '1', name: 'Report 1', tableId: 'bux123' },
          { id: '2', name: 'Report 2', tableId: 'bux123' }
        ];

        mockAxiosInstance.get.mockResolvedValue({ data: reports });

        const result = await client.getReports('bux123');

        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(2);
      });
    });

    describe('runReport', () => {
      it('should run a report', async () => {
        mockAxiosInstance.post.mockResolvedValue({
          data: {
            data: [
              { recordId: 1, fields: { 3: 'John' } },
              { recordId: 2, fields: { 3: 'Jane' } }
            ]
          }
        });

        const result = await client.runReport('report1', 'bux123');

        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(2);
      });
    });

    describe('testConnection', () => {
      it('should test connection to QuickBase', async () => {
        mockAxiosInstance.get.mockResolvedValue({
          data: { dbId: 'bux123' }
        });

        const result = await client.testConnection();

        expect(result).toBe(true);
      });

      it('should return false on connection failure', async () => {
        mockAxiosInstance.get.mockRejectedValue(new Error('Connection failed'));

        const result = await client.testConnection();

        expect(result).toBe(false);
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle API errors in relationship creation', async () => {
      mockAxiosInstance.post.mockRejectedValue(
        new Error('API Error')
      );

      await expect(
        client.createAdvancedRelationship('bux123', 'bux124', 'Ref', [])
      ).rejects.toThrow();
    });

    it('should handle errors in junction table creation', async () => {
      mockAxiosInstance.post.mockRejectedValue(
        new Error('Cannot create table')
      );

      await expect(
        client.createJunctionTable('JunctionTable', 'bux123', 'bux124', 'Ref1', 'Ref2')
      ).rejects.toThrow();
    });

    it('should handle errors in relationship details retrieval', async () => {
      mockAxiosInstance.get.mockRejectedValue(
        new Error('API Error')
      );

      await expect(
        client.getRelationshipDetails('bux124')
      ).rejects.toThrow();
    });
  });

});
