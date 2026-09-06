// A stand-in for the PostgREST query builder, so route handlers can be
// exercised without a database.
//
// The chain is deliberately permissive -- every method returns the builder --
// and each terminal call (awaiting the builder, or .maybeSingle()) hands the
// accumulated query to a handler supplied by the test. That keeps the tests
// asserting on behaviour rather than on a reimplementation of Supabase.

export type FakeRow = Record<string, unknown>;

export interface FakeQueryCall {
  table: string;
  op: 'select' | 'insert' | 'update';
  columns: string | null;
  payload: FakeRow | null;
  filters: Array<[string, string, unknown]>;
  terminal: 'then' | 'maybeSingle';
}

export interface FakeQueryResult {
  data?: unknown;
  error?: unknown;
}

export type FakeQueryHandler = (call: FakeQueryCall) => FakeQueryResult;

const emptyResult: FakeQueryResult = { data: null, error: null };

class FakeQueryBuilder implements PromiseLike<{
  data: unknown;
  error: unknown;
}> {
  op: FakeQueryCall['op'] = 'select';
  columns: string | null = null;
  payload: FakeRow | null = null;
  filters: Array<[string, string, unknown]> = [];
  terminal: FakeQueryCall['terminal'] = 'then';

  constructor(
    private readonly table: string,
    private readonly calls: FakeQueryCall[],
    private readonly handler: FakeQueryHandler
  ) {}

  select(columns?: string) {
    this.columns = columns ?? null;
    return this;
  }

  insert(payload: FakeRow) {
    this.op = 'insert';
    this.payload = payload;
    return this;
  }

  update(payload: FakeRow) {
    this.op = 'update';
    this.payload = payload;
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push(['eq', column, value]);
    return this;
  }

  is(column: string, value: unknown) {
    this.filters.push(['is', column, value]);
    return this;
  }

  gt(column: string, value: unknown) {
    this.filters.push(['gt', column, value]);
    return this;
  }

  maybeSingle() {
    this.terminal = 'maybeSingle';
    return Promise.resolve(this.settle());
  }

  then<A, B>(
    onFulfilled?:
      ((value: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B> {
    return Promise.resolve(this.settle()).then(onFulfilled, onRejected);
  }

  private settle(): { data: unknown; error: unknown } {
    const call: FakeQueryCall = {
      table: this.table,
      op: this.op,
      columns: this.columns,
      payload: this.payload,
      filters: this.filters,
      terminal: this.terminal,
    };
    this.calls.push(call);
    const result = this.handler(call) ?? emptyResult;
    return { data: result.data ?? null, error: result.error ?? null };
  }
}

/**
 * Install a fake service client and return the list of queries it receives.
 *
 * The returned array is mutated as the handler runs, so assertions can be
 * made on it after the request completes.
 */
export function installFakeSupabase(
  from: ReturnType<typeof vi.fn> | ((table: string) => unknown),
  handler: FakeQueryHandler
): FakeQueryCall[] {
  const calls: FakeQueryCall[] = [];
  (from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    return new FakeQueryBuilder(table, calls, handler);
  });
  return calls;
}
