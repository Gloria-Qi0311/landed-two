import postgres from 'postgres'

export type Sql = postgres.Sql

export function connect(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 10,
    // Keep timestamptz as ISO strings rather than Date objects. The web app
    // was written against PostgREST JSON, where timestamps are strings.
    types: {
      date: {
        to: 1184,
        from: [1082, 1083, 1114, 1184],
        serialize: (x: unknown) => (x instanceof Date ? x.toISOString() : String(x)),
        parse: (x: string) => new Date(x).toISOString(),
      },
    },
    onnotice: () => {},
  })
}
