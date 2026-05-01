const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@libsql/client");
const { DatabaseSync } = require("node:sqlite");

dotenv.config();

const TURSO_URL = process.env.TURSO_CONNECTION_URL || process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || "";
const LOCAL_DB_PATH = path.join(__dirname, "..", "data", "dashboard.sqlite");
const ROW_BATCH_SIZE = 250;

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function buildInsertSql(tableName, columns, rowCount) {
  const columnList = columns.map((column) => quoteIdentifier(column)).join(", ");
  const oneRowPlaceholders = `(${columns.map(() => "?").join(", ")})`;
  const valuesPlaceholders = new Array(rowCount).fill(oneRowPlaceholders).join(", ");
  return `INSERT INTO ${quoteIdentifier(tableName)} (${columnList}) VALUES ${valuesPlaceholders}`;
}

function flattenRows(rows, columns) {
  const args = [];
  for (const row of rows) {
    for (const column of columns) {
      args.push(row[column]);
    }
  }
  return args;
}

async function main() {
  if (!TURSO_URL) {
    throw new Error("TURSO_CONNECTION_URL or TURSO_DATABASE_URL is required in .env");
  }

  const source = new DatabaseSync(LOCAL_DB_PATH, { readonly: true });
  const target = createClient({
    url: TURSO_URL,
    authToken: TURSO_TOKEN,
  });

  try {
    const tables = source
      .prepare(`
        SELECT rowid AS schema_rowid, name, sql
        FROM sqlite_master
        WHERE type = 'table'
          AND sql IS NOT NULL
          AND name NOT LIKE 'sqlite_%'
        ORDER BY schema_rowid ASC
      `)
      .all();

    const indexes = source
      .prepare(`
        SELECT rowid AS schema_rowid, sql
        FROM sqlite_master
        WHERE type = 'index'
          AND sql IS NOT NULL
          AND name NOT LIKE 'sqlite_%'
        ORDER BY schema_rowid ASC
      `)
      .all();

    console.log(`Found ${tables.length} tables in local SQLite.`);

    await target.execute("PRAGMA foreign_keys = OFF;");

    for (const table of [...tables].reverse()) {
      await target.execute(`DROP TABLE IF EXISTS ${quoteIdentifier(table.name)}`);
    }

    for (const table of tables) {
      await target.execute(table.sql);
      console.log(`Created table: ${table.name}`);
    }

    for (const table of tables) {
      const tableName = table.name;
      const columns = source
        .prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
        .all()
        .map((column) => column.name);

      const countRow = source.prepare(`SELECT COUNT(*) AS total FROM ${quoteIdentifier(tableName)}`).get();
      const totalRows = Number(countRow.total || 0);

      if (!totalRows) {
        console.log(`Copied 0 rows for table: ${tableName}`);
        continue;
      }

      let copied = 0;
      while (copied < totalRows) {
        const rows = source
          .prepare(`SELECT * FROM ${quoteIdentifier(tableName)} LIMIT ? OFFSET ?`)
          .all(ROW_BATCH_SIZE, copied);

        if (!rows.length) {
          break;
        }

        const insertSql = buildInsertSql(tableName, columns, rows.length);
        const args = flattenRows(rows, columns);

        await target.execute({ sql: insertSql, args });
        copied += rows.length;
      }

      console.log(`Copied ${copied} rows for table: ${tableName}`);
    }

    for (const indexEntry of indexes) {
      await target.execute(indexEntry.sql);
    }

    await target.execute("PRAGMA foreign_keys = ON;");
    console.log("Schema and data sync to Turso completed.");
  } finally {
    source.close();
    target.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
