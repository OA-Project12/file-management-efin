export class InvalidFileSearchQuery extends Error {
    constructor() {
        super("invalid_search_query");
    }
}

export function normalizeFileSearchQuery(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") throw new InvalidFileSearchQuery();
    const query = value.trim().replace(/\s+/gu, " ");
    if (query.length > 200 || (query && query.split(" ").length > 10)) throw new InvalidFileSearchQuery();
    return query;
}

// Parameters are literal contains patterns, never caller-provided SQL/wildcards.
export function fileSearchPatterns(value: unknown): string[] {
    const query = normalizeFileSearchQuery(value);
    return query ? [...new Set(query.split(" "))].map((term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`) : [];
}
