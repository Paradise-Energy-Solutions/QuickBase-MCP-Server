# Unit Testing Guide

This project includes comprehensive unit tests with an initial coverage goal of **70%**.

## Overview

The test suite consists of 154 unit tests organized into four main test files:

- **types.test.ts** - Tests for Zod schema validation (100% coverage)
- **tools.test.ts** - Tests for tool schemas and definitions (100% coverage)
- **client.test.ts** - Tests for QuickBaseClient core methods (89.79% coverage)
- **client-utilities.test.ts** - Tests for utility and advanced methods (89.79% coverage)

## Current Coverage

```
File           | % Stmts | % Branch | % Funcs | % Lines
----------------|---------|----------|---------|----------
All files      |  78.62% |   50.7%  |  89.79% |  78.36%
src/quickbase  |  75.9%  |   50.0%  |  88.63% |  75.46%
src/tools      |  82.43% |  53.33%  |   100%  |  82.43%
src/types      |   100%  |   100%   |   100%  |   100%
```

**Status**: ✅ **Exceeded 70% line and statement coverage targets**

## Running Tests

### Run all tests with coverage
```bash
npm run test:unit
```

### Run tests in watch mode (for development)
```bash
npm run test:unit:watch
```

### Run tests with simplified coverage report
```bash
npm run test:coverage
```

### Run smoke tests (default test command)
```bash
npm test
```

### Run specific test file
```bash
npx jest tests/client.test.ts
```

### Run tests matching a pattern
```bash
npx jest --testNamePattern="should create"
```

## Test Organization

### Type Validation Tests (`types.test.ts`)
- FieldType enum validation
- QuickBaseField schema validation
- QuickBaseTable schema validation
- QuickBaseRecord schema validation
- QuickBaseApiResponse schema validation
- QuickBaseConfig schema validation

**Test Count**: 26 tests
**Coverage**: 100% (all Zod schemas fully tested)

### Tool Schema Tests (`tools.test.ts`)
- Tool parameter schema validation
- Tool definition validation
- Tool coverage verification

**Test Count**: 71 tests
**Coverage**: 100% (all tool schemas and exports tested)

### Client Core Methods Tests (`client.test.ts`)
- Constructor and initialization
- Application methods (getAppInfo, getAppTables)
- Table management (create, update, delete, info)
- Field management (create, update, delete, list)
- Record operations (create, update, delete, query)
- Relationship management (create, get)

**Test Count**: 37 tests
**Coverage**: 89.79% (core client methods fully tested)

### Client Utilities Tests (`client-utilities.test.ts`)
- Report management (getReports, runReport)
- Utility methods (testConnection, searchRecords)
- Bulk operations (upsertRecords)
- Advanced relationships (createAdvancedRelationship, createLookupField, validateRelationship, createJunctionTable)
- Error handling and edge cases

**Test Count**: 44 tests
**Coverage**: 89.79% (utility and advanced methods tested)

## Test Examples

### Schema Validation Example
```typescript
it('should validate a basic field', () => {
  const field = {
    label: 'Test Field',
    fieldType: 'text'
  };
  expect(QuickBaseField.parse(field)).toEqual({
    label: 'Test Field',
    fieldType: 'text',
    required: false,
    unique: false
  });
});
```

### Client Method Example
```typescript
it('should create a single record', async () => {
  mockAxiosInstance.post.mockResolvedValue({
    data: { data: [{ '3': { value: 42 } }] }
  });

  const record = { fields: { 4: 'John Doe' } };
  const result = await client.createRecord('bux123', record);

  expect(result).toBe(42);
});
```

## Coverage Thresholds

Jest is configured with the following coverage thresholds in `jest.config.js`:

```javascript
coverageThreshold: {
  global: {
    branches: 70,
    functions: 70,
    lines: 70,
    statements: 70
  }
}
```

**Current Status**:
- ✅ Lines: 78.36% (exceeds 70%)
- ✅ Statements: 78.62% (exceeds 70%)
- ✅ Functions: 89.79% (exceeds 70%)
- ❌ Branches: 50.7% (below 70% - complex conditional paths)

## Improving Coverage

To improve branch coverage beyond 70%, focus on:

1. **Error handling paths** - Test both success and failure scenarios
2. **Conditional logic** - Test all branches of if/else statements
3. **Optional parameters** - Test with and without optional values
4. **Array operations** - Test empty arrays, single items, multiple items
5. **Error types** - Test different error scenarios

### Example: Improving Branch Coverage
```typescript
// Test both branches of conditional
it('should handle both success and error cases', async () => {
  // Success case
  mockAxios.get.mockResolvedValueOnce({});
  await client.getAppInfo();
  expect(mockAxios.get).toHaveBeenCalled();
  
  // Error case
  mockAxios.get.mockRejectedValueOnce(new Error('API error'));
  await expect(client.getAppInfo()).rejects.toThrow();
});
```

## CI/CD Integration

Tests are configured to run in the CI/CD pipeline. The `prepublishOnly` script ensures tests pass before publishing:

```bash
npm run prepublishOnly
# Runs: npm ci && npm run build && npm run test
```

## Mocking Strategy

Tests use Jest's mocking capabilities to:
- Mock the Axios HTTP client for network requests
- Verify correct API calls are made
- Test error handling without actual network calls
- Control API responses for testing different scenarios

## Tips for Writing Tests

1. **Use descriptive test names** that explain what is being tested
2. **Follow the Arrange-Act-Assert pattern**:
   - Arrange: Set up test data and mocks
   - Act: Call the function being tested
   - Assert: Verify the results

3. **Mock external dependencies** like HTTP requests
4. **Test both success and failure paths**
5. **Use meaningful assertions** with clear error messages
6. **Keep tests focused** - one assertion per test when possible

## Common Issues

### Issue: Tests timeout
**Solution**: Increase Jest timeout in jest.config.js:
```javascript
testTimeout: 10000 // 10 seconds
```

### Issue: Mock not being called
**Solution**: Ensure you're using the correct mock path and that the module is imported before being mocked.

### Issue: Coverage thresholds failing
**Solution**: Add more tests for uncovered lines, especially for:
- Error handling
- Edge cases
- Optional parameters
- Complex conditional logic

## Resources

- [Jest Documentation](https://jestjs.io/)
- [Zod Documentation](https://zod.dev/)
- [Testing Best Practices](https://jestjs.io/docs/getting-started)
