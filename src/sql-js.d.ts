/**
 * Minimal type declarations for sql.js (WASM SQLite).
 * Only covers the API surface used by wasm-sqlite-adapter.ts.
 */
declare module 'sql.js' {
  interface SqlJsDatabase {
    run(sql: string, params?: unknown[]): void
    exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
    prepare(sql: string): SqlJsStatement
    close(): void
  }

  interface SqlJsStatement {
    bind(params?: unknown[]): boolean
    step(): boolean
    getAsObject(): Record<string, unknown>
    free(): void
  }

  interface SqlJsStatic {
    Database: new () => SqlJsDatabase
  }

  function initSqlJs(): Promise<SqlJsStatic>
  export default initSqlJs
}
