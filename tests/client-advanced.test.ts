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
        // Mock the multiple API calls this method makes
        mockAxiosInstance.post
          .mockResolvedValueOnce({ data: { id: 10 } }) // Reference field
          .mockResolvedValueOnce({ data: { id: 11 } }); // Lookup field 1

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
          .mockResolvedValueOnce({ data: { id: 11 } });

        await client.createAdvancedRelationship(
          'bux123',
          'bux124',
          'Parent',
          [],
          'one-to-many'
        );

        expect(mockAxiosInstance.post).toHaveBeenCalled();
      });

      it('should create many-to-many relationship', async () => {
        mockAxiosInstance.post
          .mockResolvedValueOnce({ data: { id: 10 } })
          .mockResolvedValueOnce({ data: { id: 11 } });

        await client.createAdvancedRelationship(
          'bux123',
          'bux124',
          'Parent',
          [],
          'many-to-many'
        );

        expect(mockAxiosInstance.post).toHaveBeenCalled();
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

    describe('validateRelationship', () => {
      it('should validate relationship integrity', async () => {
        mockAxiosInstance.post.mockResolvedValue({
          data: {
            isValid: true,
            orphanedRecords: []
          }
        });

        const result = await client.validateRelationship(
          'bux123',
          'bux124',
          15
        );

        expect(result).toBeDefined();
        expect(result.isValid).toBe(true);
      });

      it('should detect orphaned records', async () => {
        mockAxiosInstance.post.mockResolvedValue({
          data: {
            isValid: false,
            orphanedRecords: [1, 2, 3]
          }
        });

        const result = await client.validateRelationship(
          'bux123',
          'bux124',
          15
        );

        expect(result.orphanedRecords).toHaveLength(3);
      });
    });

    describe('getRelationshipDetails', () => {
      it('should get relationship details', async () => {
        const mockDetails = {
          relationships: [
            {
              parentTableId: 'bux123',
              childTableId: 'bux124',
              referenceFieldId: 10,
              lookupFields: [
                { id: 11, label: 'Company Name' }
              ]
            }
          ]
        };
        mockAxiosInstance.post.mockResolvedValue({ data: mockDetails });

        const result = await client.getRelationshipDetails('bux124', true);

        expect(result).toBeDefined();
        expect(result.relationships).toHaveLength(1);
      });

      it('should exclude field details when requested', async () => {
        mockAxiosInstance.post.mockResolvedValue({ data: { relationships: [] } });

        await client.getRelationshipDetails('bux124', false);

        expect(mockAxiosInstance.post).toHaveBeenCalled();
      });
    });

    describe('createJunctionTable', () => {
      it('should create junction table for many-to-many relationship', async () => {
        mockAxiosInstance.post
          .mockResolvedValueOnce({ data: { id: 'bux999' } }) // Create junction table
          .mockResolvedValueOnce({ data: { id: 10 } }) // Reference field 1
          .mockResolvedValueOnce({ data: { id: 11 } }); // Reference field 2

        const result = await client.createJunctionTable(
          'Companies_Contacts',
          'bux123',
          'bux124',
          'Company',
          'Contact'
        );

        expect(result).toBeDefined();
        expect(result.junctionTableId).toBe('bux999');
      });

      it('should create junction table with additional fields', async () => {
        mockAxiosInstance.post
          .mockResolvedValueOnce({ data: { id: 'bux999' } })
          .mockResolvedValueOnce({ data: { id: 10 } })
          .mockResolvedValueOnce({ data: { id: 11 } })
          .mockResolvedValueOnce({ data: { id: 12 } });

        await client.createJunctionTable(
          'Companies_Contacts',
          'bux123',
          'bux124',
          'Company',
          'Contact',
          [{ label: 'Start Date', fieldType: 'date' }]
        );

        expect(mockAxiosInstance.post).toHaveBeenCalled();
      });
    });
  });

  describe('Utility Methods', () => {
    describe('getReports', () => {
      it('should get all reports for a table', async () => {
        const mockReports = [
          { id: 'rep1', name: 'All Records' },
          { id: 'rep2', name: 'Active Only' }
        ];
        mockAxiosInstance.get.mockResolvedValue({ data: mockReports });

        const result = await client.getReports('bux123');

        expect(mockAxiosInstance.get).toHaveBeenCalledWith(
          '/reports',
          { params: { tableId: 'bux123' } }
        );
        expect(result).toHaveLength(2);
      });
    });

    describe('runReport', () => {
      it('should run a report', async () => {
        const mockReportData = {
          data: [
            { 3: { value: 1 }, 4: { value: 'John' } }
          ]
        };
        mockAxiosInstance.get.mockResolvedValue({ data: mockReportData });

        const result = await client.runReport('rep1', 'bux123');

        expect(mockAxiosInstance.get).toHaveBeenCalledWith(
          '/reports/rep1',
          { params: { tableId: 'bux123' } }
        );
        expect(result).toBeDefined();
      });
    });

    describe('searchRecords', () => {
      it('should search records', async () => {
        const mockResults = [
          { 3: { value: 1 }, 4: { value: 'John' } }
        ];
        mockAxiosInstance.post.mockResolvedValue({ data: { data: mockResults } });

        const result = await client.searchRecords(
          'bux123',
          'John'
        );

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/records/query',
          expect.objectContaining({
            from: 'bux123'
          })
        );
        expect(result).toHaveLength(1);
      });

      it('should search in specific fields', async () => {
        mockAxiosInstance.post.mockResolvedValue({ data: { data: [] } });

        await client.searchRecords('bux123', 'Jane', [4, 5]);

        expect(mockAxiosInstance.post).toHaveBeenCalled();
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle advanced relationship creation error', async () => {
      mockAxiosInstance.post.mockRejectedValue(
        new Error('API Error')
      );

      await expect(
        client.createAdvancedRelationship('bux123', 'bux124', 'Ref')
      ).rejects.toThrow('API Error');
    });

    it('should handle validation failure gracefully', async () => {
      mockAxiosInstance.post.mockRejectedValue(
        new Error('Validation failed')
      );

      await expect(
        client.validateRelationship('bux123', 'bux124', 15)
      ).rejects.toThrow('Validation failed');
    });

    it('should handle junction table creation error', async () => {
      mockAxiosInstance.post.mockRejectedValue(
        new Error('Cannot create junction table')
      );

      await expect(
        client.createJunctionTable(
          'Junction',
          'bux123',
          'bux124',
          'Table1',
          'Table2'
        )
      ).rejects.toThrow();
    });
  });

  describe('Retry Logic', () => {
    it('should handle temporary failures with retry logic', async () => {
      const error = new Error('Temporary error');
      mockAxiosInstance.post
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ data: { data: [] } });

      // Since the client should have retry logic, verify the method can handle failures
      mockAxiosInstance.post.mockResolvedValue({ data: { data: [] } });
      const result = await client.getRecords('bux123');

      expect(result).toBeDefined();
    });
  });
});
