import axios from 'axios';
import { formatErrorForLog } from '../src/utils/errors';

describe('formatErrorForLog', () => {
  describe('Axios errors', () => {
    it('should format AxiosError with all properties', () => {
      const axiosError = new axios.AxiosError(
        'Request failed',
        'ERR_NETWORK'
      );
      
      // Mock the response and config properties
      Object.defineProperty(axiosError, 'response', {
        value: {
          status: 404,
          statusText: 'Not Found',
          data: {},
          headers: {},
          config: {
            method: 'GET',
            url: 'https://api.example.com/tables',
            headers: {}
          }
        },
        writable: true
      });
      
      Object.defineProperty(axiosError, 'config', {
        value: {
          method: 'GET',
          url: 'https://api.example.com/tables',
          headers: {}
        },
        writable: true
      });

      const result = formatErrorForLog(axiosError);
      expect(result).toContain('AxiosError');
      expect(result).toContain('404');
      expect(result).toContain('GET');
      expect(result).toContain('https://api.example.com/tables');
      expect(result).toContain('Request failed');
    });

    it('should format AxiosError with status but no method/url', () => {
      const axiosError = new axios.AxiosError('Unauthorized', 'ERR_BAD_REQUEST');
      Object.defineProperty(axiosError, 'response', {
        value: {
          status: 401,
          statusText: 'Unauthorized',
          data: {},
          headers: {},
          config: { headers: {} }
        },
        writable: true
      });
      Object.defineProperty(axiosError, 'config', {
        value: { headers: {} },
        writable: true
      });

      const result = formatErrorForLog(axiosError);
      expect(result).toContain('AxiosError');
      expect(result).toContain('401');
      expect(result).toContain('Unauthorized');
    });

    it('should format AxiosError with method and url but no status', () => {
      const axiosError = new axios.AxiosError('Connection timeout');
      Object.defineProperty(axiosError, 'config', {
        value: { method: 'POST', url: 'https://api.example.com/records', headers: {} },
        writable: true
      });

      const result = formatErrorForLog(axiosError);
      expect(result).toContain('AxiosError');
      expect(result).toContain('POST');
      expect(result).toContain('https://api.example.com/records');
      expect(result).toContain('Connection timeout');
    });

    it('should handle AxiosError with only message', () => {
      const axiosError = new axios.AxiosError('Network error');
      
      const result = formatErrorForLog(axiosError);
      expect(result).toContain('AxiosError');
      expect(result).toContain('Network error');
    });

    it('should handle AxiosError with method but no url', () => {
      const axiosError = new axios.AxiosError('Bad request');
      Object.defineProperty(axiosError, 'config', {
        value: { method: 'DELETE', headers: {} },
        writable: true
      });

      const result = formatErrorForLog(axiosError);
      expect(result).toContain('AxiosError');
      expect(result).toContain('Bad request');
      // Should NOT include method since url is missing
      expect(result).not.toContain('DELETE');
    });
  });

  describe('Error instances', () => {
    it('should format Error instance with message', () => {
      const error = new Error('Something went wrong');
      
      const result = formatErrorForLog(error);
      expect(result).toBe('Something went wrong');
    });

    it('should format TypeError instance', () => {
      const error = new TypeError('Cannot read property "x" of undefined');
      
      const result = formatErrorForLog(error);
      expect(result).toContain('Cannot read property');
    });

    it('should handle Error with empty message', () => {
      const error = new Error('');
      
      const result = formatErrorForLog(error);
      expect(result).toBe('');
    });
  });

  describe('String values', () => {
    it('should return string as-is', () => {
      const result = formatErrorForLog('Simple error message');
      expect(result).toBe('Simple error message');
    });

    it('should handle empty string', () => {
      const result = formatErrorForLog('');
      expect(result).toBe('');
    });
  });

  describe('Serializable objects', () => {
    it('should JSON stringify plain objects', () => {
      const error = { message: 'custom error', code: 'ERR_001' };
      
      const result = formatErrorForLog(error);
      expect(result).toContain('message');
      expect(result).toContain('custom error');
      expect(result).toContain('ERR_001');
    });

    it('should JSON stringify arrays', () => {
      const error = ['error1', 'error2'];
      
      const result = formatErrorForLog(error);
      expect(result).toContain('error1');
      expect(result).toContain('error2');
    });

    it('should JSON stringify numbers', () => {
      const result = formatErrorForLog(404);
      expect(result).toBe('404');
    });

    it('should JSON stringify booleans', () => {
      const result = formatErrorForLog(true);
      expect(result).toBe('true');
    });

    it('should JSON stringify null', () => {
      const result = formatErrorForLog(null);
      expect(result).toBe('null');
    });
  });

  describe('Non-serializable objects', () => {
    it('should return "Unknown error" when JSON stringify fails', () => {
      // Create a circular reference
      const circularObj: any = { name: 'error' };
      circularObj.self = circularObj;
      
      const result = formatErrorForLog(circularObj);
      expect(result).toBe('Unknown error');
    });

    it('should handle objects with non-enumerable properties', () => {
      const error = {};
      Object.defineProperty(error, 'hidden', {
        value: 'secret',
        enumerable: false
      });
      
      const result = formatErrorForLog(error);
      expect(result).toBe('{}');
    });
  });

  describe('Edge cases', () => {
    it('should handle undefined', () => {
      const result = formatErrorForLog(undefined);
      // JSON.stringify(undefined) returns undefined (undefined value, not string)
      // So the function returns that undefined value
      expect(result).toBeUndefined();
    });

    it('should handle objects with toString override', () => {
      const error = {
        toString: () => 'Custom error',
        message: 'Original'
      };
      
      const result = formatErrorForLog(error);
      // Should use JSON.stringify, not toString
      expect(result).toContain('message');
    });

    it('should handle very large objects', () => {
      const largeObj: any = {};
      for (let i = 0; i < 100; i++) {
        largeObj[`key${i}`] = `value${i}`;
      }
      
      const result = formatErrorForLog(largeObj);
      expect(result).toContain('key0');
      expect(result).toContain('value0');
    });

    it('should handle deeply nested AxiosError', () => {
      const axiosError = new axios.AxiosError('Nested error');
      Object.defineProperty(axiosError, 'response', {
        value: {
          status: 500,
          data: { nested: { deeply: { error: 'here' } } }
        },
        writable: true
      });
      Object.defineProperty(axiosError, 'config', {
        value: { method: 'PUT', url: 'https://api.qb.com/app/123' },
        writable: true
      });
      
      const result = formatErrorForLog(axiosError);
      expect(result).toContain('AxiosError');
      expect(result).toContain('500');
      expect(result).toContain('PUT');
    });
  });
});
