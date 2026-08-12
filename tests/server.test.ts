import * as http from "http";
import { PassThrough } from "stream";
import { parse } from "@babel/parser";
import {
  createGeneratorServer,
  crossoverSource,
  extractEmbeddedWasm,
  liftSource,
  mutateSource,
  roundtripOk,
} from "../src/generator/server";
import { printProgram } from "../src/generator/printer";
import { Mutator } from "../src/mutator";
import { bitFlip } from "../src/mutator/wasm-mutators";

interface HttpResult {
  statusCode: number;
  body: string;
}

interface TestResponse {
  destroyed: boolean;
  writableEnded: boolean;
  headersSent: boolean;
  statusCode: number;
  writeHead(statusCode: number): TestResponse;
  end(body?: string): TestResponse;
  destroy(error?: Error): TestResponse;
}

describe("Generator server", () => {
  let server: http.Server;

  beforeAll(() => {
    server = createGeneratorServer({ maxBodyBytes: 64 });
  });

  function request(
    path: string,
    method = "GET",
    chunks: Buffer[] = [],
    headers: http.OutgoingHttpHeaders = {},
  ): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const requestStream = new PassThrough() as PassThrough & {
        url?: string;
        method?: string;
        headers: http.IncomingHttpHeaders;
      };
      requestStream.url = path;
      requestStream.method = method;
      requestStream.headers = headers as http.IncomingHttpHeaders;

      const response: TestResponse = {
        destroyed: false,
        writableEnded: false,
        headersSent: false,
        writeHead(statusCode: number): typeof response {
          this.statusCode = statusCode;
          this.headersSent = true;
          return this;
        },
        end(body = ""): typeof response {
          this.writableEnded = true;
          resolve({ statusCode: this.statusCode, body: String(body) });
          return this;
        },
        destroy(error?: Error): typeof response {
          this.destroyed = true;
          reject(error ?? new Error("Response destroyed"));
          return this;
        },
        statusCode: 200,
      };

      server.emit(
        "request",
        requestStream as unknown as http.IncomingMessage,
        response as unknown as http.ServerResponse,
      );

      const writeChunk = (index: number): void => {
        if (index === chunks.length) {
          requestStream.end();
          return;
        }
        requestStream.write(chunks[index]);
        setImmediate(() => writeChunk(index + 1));
      };
      writeChunk(0);
    });
  }

  it("generates deterministically with valid typed query parameters", async () => {
    const first = await request("/generate?mode=js-only&seed=17", "GET", [], {
      host: "[",
    });
    const second = await request("/generate?mode=js-only&seed=17");

    expect(first.statusCode).toBe(200);
    expect(first.body).toBe(second.body);
  });

  it.each([
    "/generate?mode=unknown&seed=1",
    "/generate?mode=js-only&seed=1garbage",
    "/crossover?seed=1.5",
  ])("rejects an invalid query value in %s", async (path) => {
    const result = await request(
      path,
      path.startsWith("/crossover") ? "POST" : "GET",
    );

    expect(result.statusCode).toBe(400);
  });

  it("bounds request bodies and remains usable after rejecting one", async () => {
    const rejected = await request(
      "/mutate",
      "POST",
      [Buffer.alloc(65, 0x61)],
      { "Content-Length": "65" },
    );
    const healthy = await request("/generate?mode=js-only&seed=18");

    expect(rejected).toEqual({
      statusCode: 413,
      body: "Request body too large",
    });
    expect(healthy.statusCode).toBe(200);
  });

  it("decodes split UTF-8 request chunks without corrupting fallback source", async () => {
    const source = "// \u{1f4a5}\nlet duplicate;\nlet duplicate;";
    const encoded = Buffer.from(source);
    const splitAt = encoded.indexOf(Buffer.from("\u{1f4a5}")) + 1;
    const result = await request("/mutate", "POST", [
      encoded.subarray(0, splitAt),
      encoded.subarray(splitAt),
    ]);

    expect(result).toEqual({ statusCode: 200, body: source });
  });

  it("lifts valid source over HTTP", async () => {
    const result = await request("/lift", "POST", [
      Buffer.from("// Flags: --test-flag\nlet value = 1;"),
    ]);
    const body = JSON.parse(result.body) as {
      ok: boolean;
      normalized: string;
      flags: string[];
    };

    expect(result.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.normalized).toContain("let value = 1;");
    expect(body.flags).toEqual(["--test-flag"]);
  });

  it("reports round-trip properties over HTTP", async () => {
    const result = await request("/roundtrip", "POST", [
      Buffer.from("const value = 1;"),
    ]);
    const body = JSON.parse(result.body) as {
      ok: boolean;
      idempotent: boolean;
      ast_faithful: boolean;
    };

    expect(result.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.idempotent).toBe(true);
    expect(body.ast_faithful).toBe(true);
  });

  it("reports invalid source over HTTP", async () => {
    const source = "function {((( ";
    const result = await request("/lift", "POST", [Buffer.from(source)]);
    const body = JSON.parse(result.body) as {
      ok: boolean;
      errors: string[];
      normalized: string;
    };

    expect(result.statusCode).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.normalized).toBe(source);
  });
});

describe("Generator server transformations", () => {
  const wasmTestcase =
    "new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,7,2,102,110,0,0,1,10,4,3,0,11]);";

  it("lifts and stably normalizes valid JavaScript", () => {
    const lifted = liftSource("const value=1;\nvalue++;");

    expect(lifted.ok).toBe(true);
    expect(lifted.errors).toEqual([]);
    expect(() => parse(lifted.normalized, { sourceType: "script" })).not.toThrow();
    expect(liftSource(lifted.normalized).normalized).toBe(lifted.normalized);
  });

  it("lifts V8 native syntax", () => {
    const lifted = liftSource(
      "let result = %OptimizeFunctionOnNextCall(target);",
    );

    expect(lifted.ok).toBe(true);
    expect(lifted.errors).toEqual([]);
  });

  it("round-trips plain JavaScript", () => {
    expect(roundtripOk("const value = 1; value++;")).toEqual({
      ok: true,
      source_type: "script",
      idempotent: true,
      ast_faithful: true,
    });
  });

  it("round-trips V8 native syntax", () => {
    const report = roundtripOk(
      "let x = %OptimizeFunctionOnNextCall(f);",
    );
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.idempotent).toBe(true);
      expect(report.ast_faithful).toBe(true);
    }
  });

  it("preserves a directive prologue through a round-trip", () => {
    const source = '"use strict";\nlet value = 1;';
    const lifted = liftSource(source);
    const report = roundtripOk(source);

    expect(report).toEqual({
      ok: true,
      source_type: "script",
      idempotent: true,
      ast_faithful: true,
    });
    expect(lifted.normalized.startsWith('"use strict";')).toBe(true);
    expect(
      parse(lifted.normalized, { sourceType: "script" }).program.directives[0]
        .value.value,
    ).toBe("use strict");
  });

  it("preserves hashbang position through a round-trip", () => {
    const source = "#!/usr/bin/env d8\nprint(1);";
    const lifted = liftSource(source);
    const report = roundtripOk(source);

    expect(lifted.ok).toBe(true);
    expect(lifted.normalized.startsWith("#!")).toBe(true);
    expect(report).toEqual({
      ok: true,
      source_type: "script",
      idempotent: true,
      ast_faithful: true,
    });
  });

  it("returns parse errors without changing broken source", () => {
    const source = "function {((( ";
    const lifted = liftSource(source);

    expect(lifted.ok).toBe(false);
    expect(lifted.errors.length).toBeGreaterThan(0);
    expect(lifted.normalized).toBe(source);
    expect(lifted.flags).toEqual([]);
  });

  it("preserves embedded wasm bytes while lifting", () => {
    const lifted = liftSource(
      "new Uint8Array([0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00]);",
    );

    expect(lifted.ok).toBe(true);
    expect(lifted.normalized).toContain("Uint8Array([");
  });

  it("round-trips embedded wasm bytes", () => {
    const source =
      "new Uint8Array([0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00]);";
    const lifted = liftSource(source);
    const report = roundtripOk(source);

    expect(lifted.normalized).toContain("Uint8Array([");
    expect(report).toEqual({
      ok: true,
      source_type: "script",
      idempotent: true,
      ast_faithful: true,
    });
  });

  it.each(["import.meta.url;", "export const x = 1;"])(
    "round-trips module-mode source: %s",
    (source) => {
      const lifted = liftSource(source);
      const report = roundtripOk(source);

      expect(lifted.ok).toBe(true);
      expect(lifted.source_type).toBe("module");
      expect(report).toEqual({
        ok: true,
        source_type: "module",
        idempotent: true,
        ast_faithful: true,
      });
    },
  );

  it("mutate lifts embedded wasm bytes so the wasm mutator can reach them", () => {
    const random = jest.spyOn(Math, "random").mockReturnValue(0);
    try {
      const result = mutateSource(wasmTestcase);
      expect(result).toContain("new Uint8Array(");
      expect(result).toContain("97");
      expect(() => parse(result, { sourceType: "script" })).not.toThrow();
    } finally {
      random.mockRestore();
    }

    const noOpAst = parse(wasmTestcase, { sourceType: "script" }) as never;
    const noOpWasm = extractEmbeddedWasm(noOpAst);
    const noOp = printProgram({
      javascript: noOpAst,
      wasm: noOpWasm,
      flags: [],
      includes: [],
    });
    const mutatedAst = parse(wasmTestcase, { sourceType: "script" }) as never;
    const mutatedWasm = extractEmbeddedWasm(mutatedAst);
    const mutated = printProgram(
      new Mutator({
        astProbability: 0,
        wasmProbability: 1,
        wasmMutators: [bitFlip],
        rng: (): number => 0.5,
      }).mutate({
        javascript: mutatedAst,
        wasm: mutatedWasm,
        flags: [],
        includes: [],
      }),
    );
    expect(mutated).not.toBe(noOp);
    expect(extractEmbeddedWasm(parse(wasmTestcase, { sourceType: "script" }) as never)).toHaveLength(1);
  });

  it("non-wasm Uint8Array literals are left in place", () => {
    const source = "const x = new Uint8Array([1, 2, 3, 4, 5]);";
    const random = jest.spyOn(Math, "random").mockReturnValue(0);
    try {
      expect(mutateSource(source)).toContain("[1, 2, 3, 4, 5]");
    } finally {
      random.mockRestore();
    }
  });

  it("Uint8Array from a non-literal source is untouched", () => {
    const source = "const x = new Uint8Array(someVar);";
    const random = jest.spyOn(Math, "random").mockReturnValue(0);
    try {
      expect(mutateSource(source)).toContain("someVar");
    } finally {
      random.mockRestore();
    }
  });

  it("returns the byte-identical input after exhausted no-op mutations", () => {
    const random = jest.spyOn(Math, "random").mockReturnValue(0);
    const source = "let value='unchanged';";

    try {
      expect(mutateSource(source)).toBe(source);
    } finally {
      random.mockRestore();
    }
  });

  it("does not treat Flags text inside a template as a header", () => {
    const random = jest
      .spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(0.7);
    const source = "const marker = `line\n// Flags: --fake\nline`;";

    try {
      const mutated = mutateSource(source);
      expect(mutated).not.toMatch(/^\/\/ Flags:/);
      expect(mutated).toContain("// Flags: --fake");
    } finally {
      random.mockRestore();
    }
  });

  it("registers destructured top-level bindings in crossover scope", () => {
    // Which seed references a visible corpus binding depends on the grammar's
    // RNG stream and shifts naturally as the grammar evolves, so scan a range
    // of seeds rather than asserting one specific (RNG-coupled) seed.
    const hits: string[] = [];
    for (let seed = 0; seed < 30; seed++) {
      const crossed = crossoverSource(
        "const { value: corpusValue } = { value: 1 };",
        seed,
      );
      if ((crossed.match(/corpusValue/g) || []).length >= 2) {
        hits.push(crossed);
      }
    }
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect((hit.match(/corpusValue/g) || []).length).toBeGreaterThanOrEqual(2);
    }
  });

  it("preserves corpus metadata and avoids every generated identifier prefix", () => {
    const source = [
      "#!/usr/bin/env d8",
      "// retained comment",
      "// Flags: --allow-natives-syntax",
      '"use strict";',
      "const { value: corpusValue } = { value: 1 };",
      "let fn_41 = corpusValue;",
    ].join("\n");
    const crossed = crossoverSource(source, 7);
    const ast = parse(crossed, {
      sourceType: "script",
      plugins: ["v8intrinsic"],
    });

    expect(crossed).toMatch(
      /^#!\/usr\/bin\/env d8\n\/\/ Flags: --allow-natives-syntax/,
    );
    expect(crossed.match(/^\/\/ Flags:/gm)).toHaveLength(1);
    expect(crossed).toContain("// retained comment");
    expect(crossed).toContain("corpusValue");
    expect(crossed).toContain("__v_42");
    expect(ast.program.directives[0].value.value).toBe("use strict");
  });
});
