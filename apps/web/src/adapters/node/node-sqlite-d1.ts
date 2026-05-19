export type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] } | T[]>;
  run(): Promise<unknown>;
};

export type D1Database = {
  prepare(query: string): D1PreparedStatement;
  batch?(statements: D1PreparedStatement[]): Promise<unknown[]>;
  exec?(query: string): Promise<unknown>;
};

export class NodeSqlitePreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly database: {
      prepare(query: string): {
        get(...values: unknown[]): unknown;
        all(...values: unknown[]): unknown[];
        run(...values: unknown[]): unknown;
      };
    },
    private readonly query: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new NodeSqlitePreparedStatement(this.database, this.query, values);
  }

  async first<T = unknown>(): Promise<T | null> {
    return (
      (this.database.prepare(this.query).get(...this.values) as
        | T
        | undefined) ?? null
    );
  }

  async all<T = unknown>(): Promise<{ results?: T[] } | T[]> {
    return this.database.prepare(this.query).all(...this.values) as T[];
  }

  async run(): Promise<unknown> {
    return this.database.prepare(this.query).run(...this.values);
  }
}

export class NodeSqliteD1Database implements D1Database {
  constructor(
    private readonly database: {
      exec(query: string): unknown;
      prepare(query: string): {
        get(...values: unknown[]): unknown;
        all(...values: unknown[]): unknown[];
        run(...values: unknown[]): unknown;
      };
    },
  ) {}

  prepare(query: string): D1PreparedStatement {
    return new NodeSqlitePreparedStatement(this.database, query);
  }

  async exec(query: string): Promise<unknown> {
    return this.database.exec(query);
  }

  async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
    if (statements.length === 0) return [];
    this.database.exec("BEGIN");
    try {
      const results: unknown[] = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
