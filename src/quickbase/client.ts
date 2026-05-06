import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { QuickBaseConfig, QuickBaseField, QuickBaseTable, QuickBaseRecord, QueryOptions } from '../types/quickbase.js';
import { RelayClient } from '../relay/server.js';
import { envFlag } from '../utils/env.js';
import { formatErrorForLog } from '../utils/errors.js';

export class QuickBaseClient {
  private axios: AxiosInstance;
  private config: QuickBaseConfig;
  private logApi: boolean;
  private relayClient: RelayClient | null = null;

  private static extractCreatedRecordIds(responseData: any): number[] {
    const normalizeIds = (ids: unknown[]): number[] =>
      ids
        .map((id) => (typeof id === 'number' ? id : Number(id)))
        .filter((n) => Number.isFinite(n));

    // Common shapes from QuickBase API for create/upsert
    const metadataIds =
      responseData?.metadata?.createdRecordIds ??
      responseData?.metadata?.recordIds ??
      responseData?.createdRecordIds;

    if (Array.isArray(metadataIds)) {
      const ids = normalizeIds(metadataIds);
      if (ids.length > 0) return ids;
    }

    // Fallback to record field 3 (Record ID) from returned data
    const rows = responseData?.data;
    if (Array.isArray(rows)) {
      const ids = rows
        .map((row: any) => {
          const recordIdCell = row?.['3'] ?? row?.[3];
          const value = recordIdCell?.value;
          return typeof value === 'number' ? value : Number(value);
        })
        .filter((n: any) => Number.isFinite(n));

      if (ids.length > 0) return ids;
    }

    return [];
  }

  constructor(config: QuickBaseConfig) {
    this.config = config;
    this.logApi = envFlag('QB_LOG_API', false);
    this.axios = axios.create({
      baseURL: `https://api.quickbase.com/v1`,
      timeout: config.timeout,
      headers: {
        'QB-Realm-Hostname': config.realm,
        'User-Agent': 'QuickBase-MCP-Server/1.0.0',
        'Authorization': `QB-USER-TOKEN ${config.userToken}`
      }
    });
    // Set Content-Type only for requests that carry a body — GET/HEAD/DELETE
    // requests must NOT send Content-Type or QuickBase returns HTTP 415.
    this.axios.defaults.headers.post['Content-Type'] = 'application/json';
    this.axios.defaults.headers.put['Content-Type'] = 'application/json';
    this.axios.defaults.headers.patch['Content-Type'] = 'application/json';

    // Add request/response interceptors for logging and error handling
    this.axios.interceptors.request.use(
      (config) => {
        if (this.logApi) {
          console.log(`QB API Request: ${config.method?.toUpperCase()} ${config.url}`);
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

    this.axios.interceptors.response.use(
      (response) => {
        if (this.logApi) {
          console.log(`QB API Response: ${response.status} ${response.config.url}`);
        }
        return response;
      },
      async (error) => {
        if (this.logApi) {
          console.error(`QB API Error: ${formatErrorForLog(error)}`);
        }

        // Retry transient errors with exponential backoff.
        type RetryConfig = AxiosRequestConfig & { _retryCount?: number };
        const config = error.config as RetryConfig | undefined;
        if (config && axios.isAxiosError(error)) {
          const status = error.response?.status;
          if (status && [429, 502, 503].includes(status)) {
            config._retryCount = (config._retryCount ?? 0) + 1;
            if (config._retryCount <= this.config.maxRetries) {
              const delayMs = Math.min(1000 * Math.pow(2, config._retryCount - 1), 30_000);
              await new Promise<void>(resolve => setTimeout(resolve, delayMs));
              return this.axios(config);
            }
          }
        }

        return Promise.reject(error);
      }
    );
  }

  // ========== APPLICATION METHODS ==========

  /** Fetch metadata for the configured QuickBase application. */
  async getAppInfo(): Promise<any> {
    const response = await this.axios.get(`/apps/${this.config.appId}`);
    return response.data;
  }

  /** Return a list of all tables in the configured application. */
  async getAppTables(): Promise<any[]> {
    const response = await this.axios.get(`/tables`, {
      params: { appId: this.config.appId }
    });
    return response.data;
  }

  // ========== TABLE METHODS ==========

  /**
   * Create a new table in the application.
   * @param table - Table configuration. `singleRecordName` defaults to the table name
   *   with a trailing 's' stripped (e.g. "Contacts" → "Contact"); supply it explicitly
   *   for irregular plurals (e.g. "Companies" → "Company").
   */
  async createTable(table: { name: string; description?: string; singleRecordName?: string }): Promise<string> {
    const derivedSingular = table.name.endsWith('s') && table.name.length > 1
      ? table.name.slice(0, -1)
      : table.name;
    const response = await this.axios.post('/tables', {
      appId: this.config.appId,
      name: table.name,
      description: table.description,
      singleRecordName: table.singleRecordName ?? derivedSingular,
      pluralRecordName: table.name
    });
    return response.data.id;
  }

  async getTableInfo(tableId: string): Promise<any> {
    const response = await this.axios.get(`/tables/${tableId}`, {
      params: { appId: this.config.appId }
    });
    return response.data;
  }

  async updateTable(tableId: string, updates: Partial<QuickBaseTable>): Promise<void> {
    await this.axios.post(`/tables/${tableId}`, {
      appId: this.config.appId,
      ...updates
    });
  }

  async deleteTable(tableId: string): Promise<void> {
    await this.axios.delete(`/tables/${tableId}`, {
      params: { appId: this.config.appId }
    });
  }

  // ========== FIELD METHODS ==========

  async getTableFields(tableId: string): Promise<any[]> {
    const response = await this.axios.get(`/fields`, {
      params: { tableId }
    });
    return response.data;
  }

  async createField(tableId: string, field: QuickBaseField): Promise<number> {
    const fieldData: any = {
      tableId,
      label: field.label,
      fieldType: field.fieldType,
      required: field.required,
      unique: field.unique
    };

    // Add field-specific properties
    if (field.choices && ['text_choice', 'multiselect'].includes(field.fieldType)) {
      fieldData.properties = {
        choices: field.choices
      };
    }

    if (field.formula && field.fieldType === 'formula') {
      fieldData.formula = field.formula;
    }

    if (field.lookupReference && field.fieldType === 'lookup') {
      fieldData.properties = {
        lookupReference: field.lookupReference
      };
    }

    const response = await this.axios.post('/fields', fieldData);
    return response.data.id;
  }

  async updateField(tableId: string, fieldId: number, updates: Partial<QuickBaseField>): Promise<void> {
    await this.axios.post(`/fields/${fieldId}`, {
      tableId,
      ...updates
    });
  }

  async deleteField(tableId: string, fieldId: number): Promise<void> {
    await this.axios.delete(`/fields/${fieldId}`, {
      params: { tableId }
    });
  }

  // ========== RECORD METHODS ==========

  async getRecords(tableId: string, options?: QueryOptions): Promise<any[]> {
    const params: any = { from: tableId };
    
    if (options?.select) {
      params.select = options.select;
    }
    if (options?.where) {
      params.where = options.where;
    }
    if (options?.sortBy) {
      params.sortBy = options.sortBy;
    }
    if (options?.groupBy) {
      params.groupBy = options.groupBy;
    }
    if (options?.top) {
      params.top = options.top;
    }
    if (options?.skip) {
      params.skip = options.skip;
    }

    const response = await this.axios.post('/records/query', params);
    return response.data.data;
  }

  async getRecord(tableId: string, recordId: number, fieldIds?: number[]): Promise<any> {
    const params: any = { from: tableId };
    if (fieldIds) {
      params.select = fieldIds;
    }

    const response = await this.axios.post('/records/query', {
      ...params,
      where: `{3.EX.${recordId}}`
    });
    
    return response.data.data[0] || null;
  }

  /**
   * Create a new record in a table.
   * @returns The new record ID, or `null` if the QuickBase API did not return one.
   */
  async createRecord(tableId: string, record: QuickBaseRecord): Promise<number | null> {
    const response = await this.axios.post('/records', {
      to: tableId,
      data: [{
        ...record.fields
      }]
    });
    const ids = QuickBaseClient.extractCreatedRecordIds(response.data);
    return ids.length > 0 ? ids[0] : null;
  }

  /**
   * Create multiple records in a single API call.
   * @returns Array of new record IDs (may be empty if the API does not return them).
   */
  async createRecords(tableId: string, records: QuickBaseRecord[]): Promise<number[]> {
    const response = await this.axios.post('/records', {
      to: tableId,
      data: records.map(record => record.fields)
    });
    const ids = QuickBaseClient.extractCreatedRecordIds(response.data);
    return ids;
  }

  async updateRecord(tableId: string, recordId: number, updates: Record<string, any>): Promise<void> {
    await this.axios.post('/records', {
      to: tableId,
      data: [{
        '3': { value: recordId }, // Record ID field
        ...updates
      }]
    });
  }

  async updateRecords(tableId: string, records: Array<{ recordId: number; updates: Record<string, any> }>): Promise<void> {
    await this.axios.post('/records', {
      to: tableId,
      data: records.map(({ recordId, updates }) => ({
        '3': { value: recordId },
        ...updates
      }))
    });
  }

  async deleteRecord(tableId: string, recordId: number): Promise<void> {
    await this.axios.delete('/records', {
      data: {
        from: tableId,
        where: `{3.EX.${recordId}}`
      }
    });
  }

  async deleteRecords(tableId: string, recordIds: number[]): Promise<void> {
    const whereClause = recordIds.map(id => `{3.EX.${id}}`).join('OR');
    await this.axios.delete('/records', {
      data: {
        from: tableId,
        where: whereClause
      }
    });
  }

  // ========== RELATIONSHIP METHODS ==========

  async createRelationship(parentTableId: string, childTableId: string, foreignKeyFieldId: number): Promise<void> {
    await this.axios.post(`/tables/${childTableId}/relationship`, {
      parentTableId,
      foreignKeyFieldId
    });
  }

  async getRelationships(tableId: string): Promise<any[]> {
    const response = await this.axios.get(`/tables/${tableId}/relationship`);
    return response.data;
  }

  // ========== ENHANCED RELATIONSHIP METHODS ==========

  async createAdvancedRelationship(
    parentTableId: string, 
    childTableId: string, 
    referenceFieldLabel: string,
    lookupFields?: Array<{ parentFieldId: number; childFieldLabel: string }>,
    relationshipType: 'one-to-many' | 'many-to-many' = 'one-to-many'
  ): Promise<{ referenceFieldId: number; lookupFieldIds: number[] }> {
    try {
      // Step 1: Create the reference field in the child table
      const referenceFieldId = await this.createField(childTableId, {
        label: referenceFieldLabel,
        fieldType: 'reference',
        required: false,
        unique: false,
        properties: {
          lookupTableId: parentTableId
        }
      });

      // Step 2: Create the relationship
      await this.createRelationship(parentTableId, childTableId, referenceFieldId);

      // Step 3: Create lookup fields if specified
      const lookupFieldIds: number[] = [];
      if (lookupFields && lookupFields.length > 0) {
        for (const lookup of lookupFields) {
          const lookupFieldId = await this.createLookupField(
            childTableId,
            parentTableId,
            referenceFieldId,
            lookup.parentFieldId,
            lookup.childFieldLabel
          );
          lookupFieldIds.push(lookupFieldId);
        }
      }

      return { referenceFieldId, lookupFieldIds };
    } catch (error) {
      console.error(`Error creating advanced relationship: ${formatErrorForLog(error)}`);
      throw error;
    }
  }

  async createLookupField(
    childTableId: string,
    parentTableId: string,
    referenceFieldId: number,
    parentFieldId: number,
    lookupFieldLabel: string
  ): Promise<number> {
    const response = await this.axios.post('/fields', {
      tableId: childTableId,
      label: lookupFieldLabel,
      fieldType: 'lookup',
      properties: {
        lookupReference: {
          tableId: parentTableId,
          fieldId: parentFieldId,
          referenceFieldId: referenceFieldId
        }
      }
    });
    return response.data.id;
  }

  async validateRelationship(
    parentTableId: string,
    childTableId: string,
    foreignKeyFieldId: number
  ): Promise<{ isValid: boolean; issues: string[]; orphanedRecords: number }> {
    const issues: string[] = [];
    let orphanedRecords = 0;

    try {
      // Check if parent table exists
      await this.getTableInfo(parentTableId);
    } catch (error) {
      issues.push(`Parent table ${parentTableId} not found`);
    }

    try {
      // Check if child table exists
      await this.getTableInfo(childTableId);
    } catch (error) {
      issues.push(`Child table ${childTableId} not found`);
    }

    try {
      // Check if foreign key field exists
      const childFields = await this.getTableFields(childTableId);
      const foreignKeyField = childFields.find(field => field.id === foreignKeyFieldId);
      if (!foreignKeyField) {
        issues.push(`Foreign key field ${foreignKeyFieldId} not found in child table`);
      } else if (foreignKeyField.fieldType !== 'reference') {
        issues.push(`Field ${foreignKeyFieldId} is not a reference field`);
      }

      // Batch the orphan check: fetch all parent record IDs in a single query,
      // then do an in-memory comparison instead of one HTTP call per child record.
      const childRecords = await this.getRecords(childTableId, {
        select: [3, foreignKeyFieldId],
        where: `{${foreignKeyFieldId}.XEX.''}` // child records that have a non-empty FK
      });

      if (childRecords.length > 0) {
        const parentRecords = await this.getRecords(parentTableId, { select: [3] });
        const parentIdSet = new Set(
          parentRecords
            .map(r => r[3]?.value)
            .filter((v): v is number | string => v != null)
        );
        for (const record of childRecords) {
          const fk = record[foreignKeyFieldId]?.value;
          if (fk != null && !parentIdSet.has(fk)) {
            orphanedRecords++;
          }
        }
      }
    } catch (error) {
      issues.push(`Error validating relationship: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return {
      isValid: issues.length === 0 && orphanedRecords === 0,
      issues,
      orphanedRecords
    };
  }

  async getRelationshipDetails(tableId: string, includeFields: boolean = true): Promise<any> {
    try {
      const relationships = await this.getRelationships(tableId);
      const tableInfo = await this.getTableInfo(tableId);

      // Fetch fields once outside the loop to avoid N+1 API calls.
      const fields = includeFields ? await this.getTableFields(tableId) : [];
      const relatedFields = fields.filter(field =>
        field.fieldType === 'reference' ||
        field.fieldType === 'lookup' ||
        (field.properties && field.properties.lookupReference)
      );

      const result = {
        tableId,
        tableName: tableInfo.name,
        relationships: [] as any[],
        relatedFields: [] as any[]
      };

      for (const relationship of relationships) {
        const relationshipDetail: any = {
          parentTableId: relationship.parentTableId,
          childTableId: relationship.childTableId,
          foreignKeyFieldId: relationship.foreignKeyFieldId,
          type: 'one-to-many' // QuickBase primarily supports one-to-many
        };

        if (includeFields) {
          relationshipDetail.relatedFields = relatedFields;
        }

        result.relationships.push(relationshipDetail);
      }

      return result;
    } catch (error) {
      console.error(`Error getting relationship details: ${formatErrorForLog(error)}`);
      throw error;
    }
  }

  async createJunctionTable(
    junctionTableName: string,
    table1Id: string,
    table2Id: string,
    table1FieldLabel: string,
    table2FieldLabel: string,
    additionalFields?: Array<{ label: string; fieldType: string }>
  ): Promise<{ junctionTableId: string; table1ReferenceFieldId: number; table2ReferenceFieldId: number }> {
    try {
      // Step 1: Create the junction table
      const junctionTableId = await this.createTable({
        name: junctionTableName,
        description: `Junction table for many-to-many relationship between tables ${table1Id} and ${table2Id}`
      });

      // Step 2: Create reference field to first table
      const table1ReferenceFieldId = await this.createField(junctionTableId, {
        label: table1FieldLabel,
        fieldType: 'reference',
        required: true,
        unique: false,
        properties: {
          lookupTableId: table1Id
        }
      });

      // Step 3: Create reference field to second table
      const table2ReferenceFieldId = await this.createField(junctionTableId, {
        label: table2FieldLabel,
        fieldType: 'reference',
        required: true,
        unique: false,
        properties: {
          lookupTableId: table2Id
        }
      });

      // Step 4: Create relationships
      await this.createRelationship(table1Id, junctionTableId, table1ReferenceFieldId);
      await this.createRelationship(table2Id, junctionTableId, table2ReferenceFieldId);

      // Step 5: Create additional fields if specified
      if (additionalFields && additionalFields.length > 0) {
        for (const field of additionalFields) {
          await this.createField(junctionTableId, {
            label: field.label,
            fieldType: field.fieldType as any,
            required: false,
            unique: false
          });
        }
      }

      return {
        junctionTableId,
        table1ReferenceFieldId,
        table2ReferenceFieldId
      };
    } catch (error) {
      console.error(`Error creating junction table: ${formatErrorForLog(error)}`);
      throw error;
    }
  }

  // ========== REPORT METHODS ==========

  async getReports(tableId: string): Promise<any[]> {
    const response = await this.axios.get('/reports', {
      params: { tableId }
    });
    return response.data;
  }

  async runReport(reportId: string, tableId: string): Promise<any[]> {
    const response = await this.axios.post('/records/query', {
      from: tableId,
      options: {
        reportId
      }
    });
    return response.data.data;
  }

  // ========== UTILITY METHODS ==========

  /**
   * Verify that the configured credentials can successfully reach the QuickBase API.
   * @returns `true` if the connection succeeds; `false` otherwise.
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.getAppInfo();
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Search records in a table for a given text term using QuickBase's CT (contains) operator.
   *
   * @param tableId    - Table to search.
   * @param searchTerm - Text to search for (trimmed to 200 characters and sanitised automatically).
   * @param fieldIds   - Field IDs to search within.  When omitted, falls back to fields **6 and 7**,
   *   which are the first two custom text fields in a *default* QuickBase table layout.
   *   For tables with a different schema this default may miss records or search the wrong fields;
   *   always supply explicit `fieldIds` for anything other than a brand-new default table.
   */
  async searchRecords(tableId: string, searchTerm: string, fieldIds?: number[]): Promise<any[]> {
    const sanitizedSearchTerm = String(searchTerm)
      .slice(0, 200)
      .replace(/[\r\n]/g, ' ')
      .replace(/'/g, "\\'");

    const whereClause = fieldIds 
      ? fieldIds.map(fieldId => `{${fieldId}.CT.'${sanitizedSearchTerm}'}`).join('OR')
      : `{6.CT.'${sanitizedSearchTerm}'}OR{7.CT.'${sanitizedSearchTerm}'}`; // Common text fields

    return this.getRecords(tableId, { where: whereClause });
  }

  // ========== BULK OPERATIONS ==========

  /**
   * Upsert (insert-or-update) multiple records using a common key field.
   *
   * ⚠️  **Breaking change from prior API**: the previous signature accepted
   * per-record `keyField` properties inside each record object:
   * ```
   * upsertRecords(tableId, [{ keyField: 4, keyValue: 'x', data: {...} }])
   * ```
   * This was redesigned because QuickBase requires **one** merge field for the
   * entire batch; per-record merge fields are not supported by the API.  The
   * new signature is:
   * ```
   * upsertRecords(tableId, 4, [{ keyValue: 'x', data: {...} }])
   * ```
   *
   * @param tableId      - Target table ID.
   * @param mergeFieldId - Field ID used as the upsert key for **all** records in this batch.
   *   All records must share the same merge field; QuickBase does not support per-record
   *   merge fields within a single batch request.
   * @param records      - Array of records to upsert.
   */
  async upsertRecords(
    tableId: string,
    mergeFieldId: number,
    records: Array<{ keyValue: unknown; data: Record<string, unknown> }>
  ): Promise<any> {
    return await this.axios.post('/records', {
      to: tableId,
      data: records.map(({ keyValue, data }) => ({
        [mergeFieldId]: { value: keyValue },
        ...data
      })),
      mergeFieldId
    });
  }

  // ========== WEBHOOK METHODS ==========

  async createWebhook(tableId: string, webhook: {
    label: string;
    description?: string;
    webhookUrl: string;
    webhookEvents: string; // 'a' (add), 'd' (delete), 'm' (modify) - can be combined like 'amd'
    messageFormat?: 'XML' | 'JSON' | 'RAW';
    messageBody?: string;
    webhookHeaders?: Record<string, string>;
    httpMethod?: 'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE';
    triggerFields?: number[]; // Only trigger on changes to specific fields
  }): Promise<string> {
    try {
      QuickBaseClient.validateWebhookUrl(webhook.webhookUrl);

      let inner = `\n  <label>${this.escapeXml(webhook.label)}</label>`;

      if (webhook.description) {
        inner += `\n  <description>${this.escapeXml(webhook.description)}</description>`;
      }

      inner += `\n  <webhookUrl>${this.escapeXml(webhook.webhookUrl)}</webhookUrl>`;
      inner += `\n  <webhookEvent>${this.escapeXml(webhook.webhookEvents)}</webhookEvent>`;

      if (webhook.messageFormat) {
        inner += `\n  <webhookMessageFormat>${this.escapeXml(webhook.messageFormat)}</webhookMessageFormat>`;
      }

      if (webhook.messageBody) {
        inner += `\n  <webhookMessage>${this.escapeXml(webhook.messageBody)}</webhookMessage>`;
      }

      if (webhook.httpMethod) {
        inner += `\n  <webhookHTTPVerb>${this.escapeXml(webhook.httpMethod)}</webhookHTTPVerb>`;
      }

      if (webhook.webhookHeaders && Object.keys(webhook.webhookHeaders).length > 0) {
        const headerEntries = Object.entries(webhook.webhookHeaders);
        inner += `\n  <webhookHeaderCount>${headerEntries.length}</webhookHeaderCount>`;
        headerEntries.forEach(([key, value], index) => {
          inner += `\n  <webhookHeaderKey${index + 1}>${this.escapeXml(key)}</webhookHeaderKey${index + 1}>`;
          inner += `\n  <webhookHeaderValue${index + 1}>${this.escapeXml(value)}</webhookHeaderValue${index + 1}>`;
        });
      }

      if (webhook.triggerFields && webhook.triggerFields.length > 0) {
        inner += `\n  <tfidsWhich>TRUE</tfidsWhich>`;
        webhook.triggerFields.forEach(fieldId => {
          inner += `\n  <tfids>${fieldId}</tfids>`;
        });
      }

      // Legacy XML API lives at https://{realm}/db/{tableId}, NOT at api.quickbase.com/v1
      const data = await this.callLegacyXmlApi(tableId, 'API_Webhooks_Create', inner);
      return data.webhookId || data.id;
    } catch (error) {
      console.error(`Error creating webhook: ${formatErrorForLog(error)}`);
      throw error;
    }
  }

  /**
   * List all webhooks in the app, optionally filtered to a specific table.
   *
   * Uses the REST API `GET /apps/{appId}/events` endpoint — the only officially
   * supported read path for webhook metadata. There is no per-table list endpoint
   * in the QuickBase REST or legacy XML APIs.
   */
  async listWebhooks(tableId?: string): Promise<any[]> {
    try {
      const response = await this.axios.get(`/apps/${this.config.appId}/events`);
      const events: any[] = Array.isArray(response.data) ? response.data : [];
      const webhooks = events.filter((e: any) => e.type === 'webhook');
      // Note: the REST /events endpoint does not expose webhook URL, HTTP verb,
      // trigger event, or message format. These fields are not available via any
      // accessible QB API (the XML API_Webhooks_GetInfo action does not exist in
      // this realm). Returned fields: name, owner, isActive, tableId, type.
      return webhooks;
    } catch (error) {
      console.error(`Error listing webhooks: ${formatErrorForLog(error)}`);
      throw error;
    }
  }

  async getWebhook(tableId: string, webhookId: string): Promise<any> {
    try {
      // Legacy XML API — action name per QuickBase XML API documentation pattern.
      const data = await this.callLegacyXmlApi(
        tableId,
        'API_Webhooks_GetInfo',
        `\n  <webhookId>${this.escapeXml(webhookId)}</webhookId>`
      );
      return data;
    } catch (error) {
      console.error(`Error getting webhook: ${formatErrorForLog(error)}`);
      throw error;
    }
  }

  async deleteWebhook(tableId: string, webhookId: string): Promise<void> {
    try {
      // API_Webhooks_Delete requires a comma-separated `actionIDList` parameter,
      // not `webhookId` — see https://help.quickbase.com/docs/api-webhooks-delete
      await this.callLegacyXmlApi(
        tableId,
        'API_Webhooks_Delete',
        `\n  <actionIDList>${this.escapeXml(webhookId)}</actionIDList>`
      );
    } catch (error) {
      console.error(`Error deleting webhook: ${formatErrorForLog(error)}`);
      throw error;
    }
  }

  async testWebhook(webhookUrl: string, testPayload: Record<string, any>, headers?: Record<string, string>): Promise<any> {
    try {
      QuickBaseClient.validateWebhookUrl(webhookUrl);

      const config: AxiosRequestConfig = {
        headers: {
          'Content-Type': 'application/json',
          ...(headers ?? {})
        },
        timeout: 10_000 // 10-second timeout for test requests
      };

      const response = await axios.post(webhookUrl, testPayload, config);
      return {
        success: true,
        statusCode: response.status,
        data: response.data
      };
    } catch (error) {
      return {
        success: false,
        error: formatErrorForLog(error),
        statusCode: axios.isAxiosError(error) ? error.response?.status : undefined
      };
    }
  }

  // ========== NOTIFICATION METHODS ==========

  async createNotification(tableId: string, notification: {
    label: string;
    description?: string;
    notificationEvent: string; // 'add', 'modify', 'delete'
    recipientEmail: string;
    messageSubject: string;
    messageBody: string;
    includeAllFields?: boolean;
    triggerFields?: number[];
  }): Promise<string> {
    try {
      let inner = `\n  <label>${this.escapeXml(notification.label)}</label>`;

      if (notification.description) {
        inner += `\n  <description>${this.escapeXml(notification.description)}</description>`;
      }

      inner += `\n  <notificationEvent>${this.escapeXml(notification.notificationEvent)}</notificationEvent>`;
      inner += `\n  <recipientEmail>${this.escapeXml(notification.recipientEmail)}</recipientEmail>`;
      inner += `\n  <messageSubject>${this.escapeXml(notification.messageSubject)}</messageSubject>`;
      inner += `\n  <messageBody>${this.escapeXml(notification.messageBody)}</messageBody>`;

      if (notification.includeAllFields) {
        inner += `\n  <includeAllFields>TRUE</includeAllFields>`;
      }

      if (notification.triggerFields && notification.triggerFields.length > 0) {
        inner += `\n  <tfidsWhich>TRUE</tfidsWhich>`;
        notification.triggerFields.forEach(fieldId => {
          inner += `\n  <tfids>${fieldId}</tfids>`;
        });
      }

      // Legacy XML API lives at https://{realm}/db/{tableId}, NOT at api.quickbase.com/v1
      const data = await this.callLegacyXmlApi(tableId, 'API_SetNotification', inner);
      return data.notificationId || data.id;
    } catch (error) {
      console.error(`Error creating notification: ${formatErrorForLog(error)}`);
      throw error;
    }
  }

  /**
   * List all email-notification events in the app.
   *
   * Uses the REST API `GET /apps/{appId}/events` endpoint — the only officially
   * supported read path for notification metadata in the QuickBase REST API.
   * The `tableId` parameter is accepted for API compatibility but the REST event
   * endpoint does not expose per-table filtering.
   */
  async listNotifications(tableId?: string): Promise<any[]> {
    try {
      const response = await this.axios.get(`/apps/${this.config.appId}/events`);
      const events: any[] = Array.isArray(response.data) ? response.data : [];
      return events.filter((e: any) => e.type === 'email-notification');
    } catch (error) {
      console.error(`Error listing notifications: ${formatErrorForLog(error)}`);
      throw error;
    }
  }

  async deleteNotification(tableId: string, notificationId: string): Promise<void> {
    try {
      // Legacy XML API lives at https://{realm}/db/{tableId}, NOT at api.quickbase.com/v1
      await this.callLegacyXmlApi(
        tableId,
        'API_DeleteNotification',
        `\n  <notificationId>${this.escapeXml(notificationId)}</notificationId>`
      );
    } catch (error) {
      console.error(`Error deleting notification: ${formatErrorForLog(error)}`);
      throw error;
    }
  }

  // ========== HELPER METHODS ==========

  /**
   * Validate that a webhook URL is safe to call (SSRF prevention).
   * Rules: must use HTTPS; must not target localhost, loopback, or any
   * RFC-1918 / link-local / shared-address IPv4 range, or any private/
   * reserved IPv6 range.
   *
   * ⚠️  DNS-rebinding limitation: this validation checks the URL text at
   * call time. It cannot defend against an attacker who initially resolves
   * a domain to a public IP, passes validation, and then changes their DNS
   * to redirect subsequent requests to a private address. This is an inherent
   * limitation of URL-based pre-flight validation. Full protection would
   * require resolving the hostname and re-checking the resulting IP just
   * before every HTTP request, which is outside the scope of this
   * implementation.
   *
   * @throws {Error} if the URL fails any validation check.
   */
  private static validateWebhookUrl(rawUrl: string): void {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(`Invalid webhook URL: "${rawUrl}"`);
    }

    if (parsed.protocol !== 'https:') {
      throw new Error('Webhook URL must use the HTTPS scheme.');
    }

    const hostname = parsed.hostname.toLowerCase();

    if (hostname === 'localhost' || hostname === '::1') {
      throw new Error('Webhook URL targets a blocked address (localhost).');
    }

    const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
      const [a, b] = ipv4Match.slice(1, 3).map(Number);
      const isPrivate =
        a === 10 ||                              // 10.0.0.0/8
        (a === 172 && b >= 16 && b <= 31) ||     // 172.16.0.0/12
        (a === 192 && b === 168) ||              // 192.168.0.0/16
        a === 127 ||                             // 127.0.0.0/8 loopback
        (a === 169 && b === 254) ||              // 169.254.0.0/16 link-local
        (a === 100 && b >= 64 && b <= 127) ||    // 100.64.0.0/10 shared
        a === 0;                                 // 0.0.0.0/8
      if (isPrivate) {
        throw new Error(
          `Webhook URL targets a private or reserved IP address (${hostname}). ` +
          'Only publicly routable HTTPS endpoints are permitted.'
        );
      }
    }

    // IPv6 private/reserved range checks (the ::1 loopback is already handled above).
    if (hostname.includes(':')) {
      const isPrivateIPv6 =
        hostname === '::' ||                   // unspecified address
        /^fe[89ab]/i.test(hostname) ||         // fe80::/10 link-local (fe80–febf)
        /^f[cd]/i.test(hostname);              // fc00::/7 unique-local (fc00–fdff)
      if (isPrivateIPv6) {
        throw new Error(
          `Webhook URL targets a private or reserved IPv6 address (${hostname}). ` +
          'Only publicly routable HTTPS endpoints are permitted.'
        );
      }
    }
  }

  /**
   * Call the QuickBase legacy XML API.
   *
   * The legacy API lives at `https://{realm}/db/{tableId}?a={action}` — a completely
   * different hostname and path from the REST API at `https://api.quickbase.com/v1`.
   * Authentication is supplied via `<usertoken>` inside the XML body.
   *
   * @param tableId - The QuickBase table ID (dbid).
   * @param action  - The XML API action name, e.g. `API_Webhooks_Create`.
   * @param inner   - Additional XML elements to embed after `<usertoken>`.
   * @returns Parsed response data from QuickBase.
   */
  private async callLegacyXmlApi(tableId: string, action: string, inner = ''): Promise<any> {
    const url = `https://${this.config.realm}/db/${tableId}?a=${action}`;
    const body = this.buildXmlBody(
      `\n  <usertoken>${this.escapeXml(this.config.userToken)}</usertoken>${inner}`
    );
    const response = await axios.post(url, body, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: this.config.timeout
    });
    return response.data;
  }

  /**
   * Wrap inner XML elements in a standard QuickBase XML API request envelope.
   * @param inner - XML element strings to embed inside `<qdbapi>`. Defaults to empty.
   */
  private buildXmlBody(inner = ''): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<qdbapi>${inner}\n</qdbapi>`;
  }

  private escapeXml(str: string): string {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Extract a plain-text value from an XML element using a simple regex.
   * Safe for flat single-occurrence text nodes; not a full XML parser.
   */
  /**
   * Extract a plain-text value from an XML element using a simple regex.
   * Safe for flat single-occurrence text nodes; not a full XML parser.
   *
   * The `tag` parameter is escaped before being embedded in the RegExp so
   * that callers cannot accidentally (or maliciously) inject regex syntax.
   */
  private extractXmlField(xml: unknown, tag: string): string | undefined {
    if (typeof xml !== 'string') return undefined;
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\\$&');
    const m = xml.match(new RegExp(`<${escapedTag}[^>]*>([^<]*)</${escapedTag}>`, 'i'));
    return m?.[1];
  }

  // ========== RELAY CLIENT ==========

  /** Inject the relay client after construction (avoids circular dependency). */
  setRelayClient(relay: RelayClient): void {
    this.relayClient = relay;
  }

  private requireRelay(): RelayClient {
    if (!this.relayClient) {
      throw new Error('Pipeline relay client is not configured. Ensure the relay server started successfully.');
    }
    return this.relayClient;
  }

  /**
   * Unwrap a relay result, throwing a descriptive McpError on non-2xx status or
   * network-level errors (status === 0). Keeps all pipeline methods DRY.
   */
  private unwrapRelayResult(result: { status: number; data: unknown; error?: string }): unknown {
    if (result.error || result.status === 0 || result.status >= 400) {
      const detail = result.error
        ?? (result.data != null ? JSON.stringify(result.data) : 'no details returned');
      if (result.status === 403) {
        throw new McpError(
          ErrorCode.InternalError,
          `Pipeline API returned 403 Forbidden — you do not have permission to access this resource. If it belongs to another user, pass impersonateUserId (use quickbase_find_pipeline_users to look up their ID). Detail: ${detail}`
        );
      }
      throw new McpError(
        ErrorCode.InternalError,
        `Pipeline API error (HTTP ${result.status}): ${detail}`
      );
    }
    return result.data;
  }

  // ========== PIPELINE METHODS (Unofficial API — may break without notice) ==========

  async listPipelines(opts: {
    pageNumber?: number;
    pageSize?: number;
    realmWide?: boolean;
    /** Filter by QB Pipelines channel name(s), e.g. ["webhooks"] or ["quickbase"]. */
    channels?: string[];
    /** Filter by pipeline tag(s). */
    tags?: string[];
    impersonateUserId?: string;
  } = {}): Promise<any> {
    const relay = this.requireRelay();
    const { pageNumber = 1, pageSize = 25, realmWide = false,
             channels = [], tags = [], impersonateUserId } = opts;

    if (impersonateUserId) await this.startPipelineImpersonation(impersonateUserId);
    try {
      const result = await relay.request(
        `/api/v2/pipelines/query/paged?pageNumber=${pageNumber}&pageSize=${pageSize}`,
        'POST',
        { tags, channels, users: [], searchString: '', requestRealmPipelines: realmWide }
      );
      return this.unwrapRelayResult(result);
    } finally {
      if (impersonateUserId) await this.endPipelineImpersonation().catch(() => {});
    }
  }

  async getPipelineDetail(pipelineId: string, impersonateUserId?: string): Promise<any> {
    const relay = this.requireRelay();
    if (impersonateUserId) await this.startPipelineImpersonation(impersonateUserId);
    try {
      const result = await relay.request(
        `/api/v2/pipelines/${encodeURIComponent(pipelineId)}/designer?open=true`,
        'GET'
      );
      return this.unwrapRelayResult(result);
    } finally {
      if (impersonateUserId) await this.endPipelineImpersonation().catch(() => {});
    }
  }

  async getPipelineActivity(pipelineId: string, opts: {
    startDate?: string;
    endDate?: string;
    perPage?: number;
    impersonateUserId?: string;
  } = {}): Promise<any> {
    const relay = this.requireRelay();
    const { perPage = 25, impersonateUserId } = opts;

    const now = Math.floor(Date.now() / 1000);

    const startMs = opts.startDate ? new Date(opts.startDate).getTime() : NaN;
    if (opts.startDate && isNaN(startMs)) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid startDate: "${opts.startDate}" is not a valid date`);
    }
    const endMs = opts.endDate ? new Date(opts.endDate).getTime() : NaN;
    if (opts.endDate && isNaN(endMs)) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid endDate: "${opts.endDate}" is not a valid date`);
    }

    const start = opts.startDate ? Math.floor(startMs / 1000) : now - 7 * 86400;
    const end = opts.endDate ? Math.floor(endMs / 1000) : now;

    // Multi-value scope params must use append() — URLSearchParams constructor
    // would merge duplicate keys into a single value, losing 'pipe' and 'poller'.
    const qs = new URLSearchParams();
    qs.append('start', String(start));
    qs.append('end', String(end));
    qs.append('scope', 'pipe');
    qs.append('scope', 'poller');
    qs.append('scope', 'pipeline');
    qs.append('per_page', String(perPage));
    qs.append('pipeline_id', pipelineId);
    qs.append('pipeline_run_id', '');
    qs.append('offset', '');

    if (impersonateUserId) await this.startPipelineImpersonation(impersonateUserId);
    try {
      const result = await relay.request(`/api/v2/activity?${qs.toString()}`, 'GET');
      const data = this.unwrapRelayResult(result) as Record<string, unknown>;
      if (Array.isArray(data?.items) && (data.items as unknown[]).length === 0) {
        data._note = 'No activity found in the requested time window. '
          + 'Try widening the date range. '
          + 'Note: a 403 (permission denied) surfaces as an McpError, not an empty list.';
      }
      return data;
    } finally {
      if (impersonateUserId) await this.endPipelineImpersonation().catch(() => {});
    }
  }

  /**
   * Fetch the full step configuration for a single pipeline node.
   *
   * The standard `getPipelineDetail` (designer) endpoint returns the pipeline
   * tree with node IDs but omits step-level config (webhook URL, HTTP method,
   * request body, headers, field mappings). This method calls the step-level
   * endpoint directly so agents can inspect individual step settings without
   * falling back to the activity log.
   */
  async getPipelineStepConfig(pipelineId: string, stepId: string, impersonateUserId?: string): Promise<any> {
    const relay = this.requireRelay();
    if (impersonateUserId) await this.startPipelineImpersonation(impersonateUserId);
    try {
      const result = await relay.request(
        `/api/v2/pipelines/${encodeURIComponent(pipelineId)}/steps/${encodeURIComponent(stepId)}`,
        'GET'
      );
      return this.unwrapRelayResult(result);
    } finally {
      if (impersonateUserId) await this.endPipelineImpersonation().catch(() => {});
    }
  }

  async findPipelineUsers(query: string): Promise<any> {
    const relay = this.requireRelay();
    const result = await relay.request(
      `/api/realm/findmatchingusers/${encodeURIComponent(query)}`,
      'GET'
    );
    return this.unwrapRelayResult(result);
  }

  async startPipelineImpersonation(qbUserId: string): Promise<any> {
    const relay = this.requireRelay();
    const result = await relay.request(
      '/api/impersonation/realm/start',
      'POST',
      { qb_user_id: qbUserId }
    );
    return this.unwrapRelayResult(result);
  }

  async endPipelineImpersonation(): Promise<any> {
    const relay = this.requireRelay();
    const result = await relay.request('/api/impersonation/end', 'POST', {});
    return this.unwrapRelayResult(result);
  }
}