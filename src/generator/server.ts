import * as http from "http";
import { URL } from "url";
import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { Generator, printProgram, GeneratorConfig } from "./index";
import {
  ReconfuzzProgram,
  WasmModule,
  Scope,
  ensureIdCounterAbove,
  resetIdCounter,
} from "./ast";
import { JsGrammar, mulberry32 } from "./js-grammar";
import { Mutator } from "../mutator/index";

const DEFAULT_PORT = 3000;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const GENERATOR_MODES: ReadonlySet<GeneratorConfig["mode"]> = new Set([
  "js-only",
  "wasm-only",
  "hybrid",
  "gc-only",
]);
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const PARSER_PLUGINS = [
  "v8intrinsic",
  "deferredImportEvaluation",
  "decoratorAutoAccessors",
] as const;
const FLAGS_COMMENT = /^\s*Flags:(.*)$/;

export interface GeneratorServerOptions {
  maxBodyBytes?: number;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface ParsedSource {
  ast: t.File;
  flags: string[];
}

function removeComment(ast: t.File, target: t.Comment): void {
  const isTarget = (comment: t.Comment): boolean =>
    comment.start === target.start && comment.end === target.end;
  const removeFromNode = (node: t.Node): void => {
    node.leadingComments = node.leadingComments?.filter(
      (comment) => !isTarget(comment),
    );
    node.innerComments = node.innerComments?.filter(
      (comment) => !isTarget(comment),
    );
    node.trailingComments = node.trailingComments?.filter(
      (comment) => !isTarget(comment),
    );
  };
  t.traverseFast(ast, removeFromNode);
  if (ast.program.interpreter) {
    removeFromNode(ast.program.interpreter);
  }
  ast.comments = ast.comments?.filter((comment) => !isTarget(comment));
}

function parseSource(source: string): ParsedSource {
  const parsed = parse(source, {
    sourceType: "script",
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins: [...PARSER_PLUGINS],
  });
  if (parsed.errors && parsed.errors.length > 0) {
    throw parsed.errors[0];
  }

  const ast = parsed as unknown as t.File;
  const firstExecutableOffset = [
    ast.program.directives[0]?.start,
    ast.program.body[0]?.start,
  ].reduce<number>(
    (first, offset) =>
      typeof offset === "number" ? Math.min(first, offset) : first,
    source.length,
  );
  const flagsComment = ast.comments?.find(
    (comment) =>
      comment.type === "CommentLine" &&
      typeof comment.start === "number" &&
      comment.start < firstExecutableOffset &&
      FLAGS_COMMENT.test(comment.value),
  );
  if (!flagsComment) return { ast, flags: [] };

  const match = flagsComment.value.match(FLAGS_COMMENT);
  const flags = match
    ? match[1].trim().split(/\s+/).filter(Boolean)
    : [];
  removeComment(ast, flagsComment);
  return { ast, flags };
}

export function extractEmbeddedWasm(ast: t.File): WasmModule[] {
  const matches: Array<{
    newExpression: t.NewExpression;
    values: number[];
  }> = [];

  t.traverseFast(ast, (node) => {
    if (
      !t.isNewExpression(node) ||
      !t.isIdentifier(node.callee, { name: "Uint8Array" }) ||
      node.arguments.length !== 1
    ) {
      return;
    }

    const argument = node.arguments[0];
    if (!t.isArrayExpression(argument)) return;
    if (
      argument.elements.length < WASM_MAGIC.length + 1 ||
      !argument.elements.every(t.isNumericLiteral)
    ) {
      return;
    }

    const values = argument.elements.map((element) => element.value);
    if (!WASM_MAGIC.every((byte, index) => values[index] === byte)) return;
    matches.push({ newExpression: node, values });
  });

  return matches.map(({ newExpression, values }, index) => {
    const name = `extracted_${index}`;
    newExpression.arguments[0] = t.callExpression(
      t.identifier("__reconfuzz_wasm_bytes"),
      [t.stringLiteral(name)],
    );
    return { name, bytes: new Uint8Array(values.map((value) => value & 0xff)) };
  });
}

function printServerProgram(program: ReconfuzzProgram): string {
  const source = printProgram(program);
  if (!program.javascript.program.interpreter || program.flags.length === 0) {
    return source;
  }

  const headerEnd = source.indexOf("\n");
  const body = source.slice(headerEnd + 1);
  const shebangEnd = body.indexOf("\n");
  if (headerEnd < 0 || !body.startsWith("#!")) {
    return source;
  }
  if (shebangEnd < 0) {
    return `${body}\n${source.slice(0, headerEnd)}`;
  }
  return `${body.slice(0, shebangEnd)}\n${source.slice(0, headerEnd)}${body.slice(shebangEnd)}`;
}

export function liftSource(source: string): {
  ok: boolean;
  errors: string[];
  normalized: string;
  flags: string[];
  source_type: "script" | "module";
} {
  type SourceType = "script" | "module";
  type ParseAttempt = {
    ast?: t.File;
    errors: unknown[];
    sourceType: SourceType;
  };

  const parseAttempt = (sourceType: SourceType): ParseAttempt => {
    try {
      const parsed = parse(source, {
        sourceType,
        allowReturnOutsideFunction: true,
        errorRecovery: true,
        plugins: [...PARSER_PLUGINS],
      });
      return {
        ast: parsed as unknown as t.File,
        errors: parsed.errors ?? [],
        sourceType,
      };
    } catch (error) {
      return { errors: [error], sourceType };
    }
  };

  const isModuleOnlyError = (error: unknown): boolean =>
    /sourceType:\s*["']?module|import\.meta|only available in modules/i.test(
      String(error),
    );

  const scriptAttempt = parseAttempt("script");
  let chosen = scriptAttempt;
  if (
    !scriptAttempt.ast ||
    scriptAttempt.errors.some((error) => isModuleOnlyError(error))
  ) {
    const moduleAttempt = parseAttempt("module");
    if (
      moduleAttempt.errors.length < scriptAttempt.errors.length ||
      (scriptAttempt.errors.length > 0 && moduleAttempt.errors.length === 0)
    ) {
      chosen = moduleAttempt;
    }
  }

  if (!chosen.ast || chosen.errors.length > 0) {
    return {
      ok: false,
      errors: chosen.errors.map(String),
      normalized: source,
      flags: [],
      source_type: chosen.sourceType,
    };
  }

  const ast = chosen.ast;
  const firstExecutableOffset = [
    ast.program.directives[0]?.start,
    ast.program.body[0]?.start,
  ].reduce<number>(
    (first, offset) =>
      typeof offset === "number" ? Math.min(first, offset) : first,
    source.length,
  );
  const flagsComment = ast.comments?.find(
    (comment) =>
      comment.type === "CommentLine" &&
      typeof comment.start === "number" &&
      comment.start < firstExecutableOffset &&
      FLAGS_COMMENT.test(comment.value),
  );
  const match = flagsComment?.value.match(FLAGS_COMMENT);
  const flags = match
    ? match[1].trim().split(/\s+/).filter(Boolean)
    : [];
  if (flagsComment) removeComment(ast, flagsComment);

  const wasm = extractEmbeddedWasm(ast);
  const normalized = printServerProgram({
    javascript: ast,
    wasm,
    flags,
    includes: [],
  });
  return {
    ok: true,
    errors: [],
    normalized,
    flags,
    source_type: ast.program.sourceType as "script" | "module",
  };
}

export function roundtripOk(source: string):
  | { ok: false }
  | {
      ok: true;
      source_type: "script" | "module";
      idempotent: boolean;
      ast_faithful: boolean;
    } {
  const out1 = liftSource(source);
  if (!out1.ok) return { ok: false };

  const out2 = liftSource(out1.normalized);
  const idempotent = out2.ok && out2.normalized === out1.normalized;
  let ast_faithful = false;
  try {
    const parseForComparison = (input: string): t.File => {
      const parsed = parse(input, {
        sourceType: out1.source_type,
        allowReturnOutsideFunction: true,
        errorRecovery: true,
        plugins: [...PARSER_PLUGINS],
      });
      if (parsed.errors && parsed.errors.length > 0) {
        throw parsed.errors[0];
      }
      return parsed as unknown as t.File;
    };
    const originalAst = parseForComparison(source);
    const normalizedAst = parseForComparison(out1.normalized);
    const originalDirectives = originalAst.program.directives.map(
      (directive) => directive.value.value,
    );
    const normalizedDirectives = normalizedAst.program.directives.map(
      (directive) => directive.value.value,
    );
    const originalBodyTypes = originalAst.program.body.map((node) => node.type);
    const normalizedBodyTypes = normalizedAst.program.body.map((node) => node.type);
    ast_faithful =
      originalAst.program.sourceType === normalizedAst.program.sourceType &&
      JSON.stringify(originalDirectives) === JSON.stringify(normalizedDirectives) &&
      originalBodyTypes.length === normalizedBodyTypes.length &&
      originalBodyTypes.every((type, index) => type === normalizedBodyTypes[index]);
  } catch {
    ast_faithful = false;
  }

  return {
    ok: true,
    source_type: out1.source_type,
    idempotent,
    ast_faithful,
  };
}

/**
 * Crossover: splice a corpus seed with a freshly generated program.
 * The corpus program stays intact (as a prefix, so its declarations work),
 * and the grammar generates a new body with the corpus's top-level
 * declarations registered in scope — so generated code (JIT loops, method
 * calls, ...) can actually call corpus functions and mutate corpus objects.
 */
export function crossoverSource(source: string, seed: number): string {
  resetIdCounter();
  const { ast: corpusAst, flags: sourceFlags } = parseSource(source);
  const corpusWasm = extractEmbeddedWasm(corpusAst);

  // Collect the seed's top-level declarations for the grammar's scope, and
  // bump the id counter past names that share the grammar's global counter.
  const scope = new Scope();
  let maxGeneratedId = -1;
  for (const stmt of corpusAst.program.body) {
    if (stmt.type === "FunctionDeclaration" && stmt.id) {
      scope.declare(stmt.id.name, "var", "function");
    } else if (stmt.type === "ClassDeclaration" && stmt.id) {
      scope.declare(stmt.id.name, "let", "class");
    } else if (stmt.type === "VariableDeclaration") {
      const kind =
        stmt.kind === "var" || stmt.kind === "let" ? stmt.kind : "const";
      for (const decl of stmt.declarations) {
        for (const name of Object.keys(t.getBindingIdentifiers(decl.id))) {
          scope.declare(name, kind, "any");
        }
      }
    }
  }
  t.traverseFast(corpusAst, (node) => {
    if (!t.isIdentifier(node)) return;
    const match = node.name.match(/^(?:__v|fn|Cls|key)_(\d+)$/);
    if (!match) return;
    const id = Number(match[1]);
    if (Number.isSafeInteger(id) && id > maxGeneratedId) {
      maxGeneratedId = id;
    }
  });
  ensureIdCounterAbove(maxGeneratedId);

  const grammar = new JsGrammar({}, seed);
  const generatedAst = grammar.generateProgram(scope);

  const merged = t.file(
    t.program(
      [...corpusAst.program.body, ...generatedAst.program.body],
      corpusAst.program.directives,
      corpusAst.program.sourceType,
      corpusAst.program.interpreter,
    ),
  );
  const flags = Array.from(
    new Set([...sourceFlags, ...grammar.requiredFlags]),
  );
  return printServerProgram({
    javascript: merged,
    wasm: corpusWasm,
    flags,
    includes: [],
  });
}

export function mutateSource(source: string, seed?: number): string {
  // Preserve the original // Flags: header so the runner keeps passing the
  // testcase's required d8 flags.
  const { ast, flags } = parseSource(source);
  const wasm = extractEmbeddedWasm(ast);
  const program: ReconfuzzProgram = {
    javascript: ast,
    wasm,
    flags,
    includes: [],
  };
  const original = printServerProgram(program);
  const rng = seed === undefined ? Math.random : mulberry32(seed);
  const seededMutator = new Mutator({ rng });
  for (let attempt = 0; attempt < 8; attempt++) {
    let candidate = program;
    const rounds = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < rounds; i++) {
      candidate = seededMutator.mutate(candidate);
    }
    const printed = printServerProgram(candidate);
    if (printed !== original) {
      return printed;
    }
  }
  return source;
}

function parseMode(value: string | null): GeneratorConfig["mode"] {
  if (value === null || value === "") return "hybrid";
  if (!GENERATOR_MODES.has(value as GeneratorConfig["mode"])) {
    throw new HttpError(400, `Invalid generator mode: ${value}`);
  }
  return value as GeneratorConfig["mode"];
}

function parseSeed(value: string | null): number {
  if (value === null || value === "") {
    return Math.floor(Math.random() * 2 ** 31);
  }
  if (!/^[+-]?\d+$/.test(value)) {
    throw new HttpError(400, `Invalid seed: ${value}`);
  }
  const seed = Number(value);
  if (!Number.isSafeInteger(seed)) {
    throw new HttpError(400, `Invalid seed: ${value}`);
  }
  return seed;
}

function parsePort(value: string | undefined): number {
  const port = value === undefined ? DEFAULT_PORT : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

function readRequestBody(
  req: http.IncomingMessage,
  maxBodyBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;

    const cleanup = (): void => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("aborted", onAborted);
      req.removeListener("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBodyBytes) {
        cleanup();
        req.once("error", () => undefined);
        req.resume();
        reject(new HttpError(413, "Request body too large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks, receivedBytes).toString("utf8"));
    };
    const onAborted = (): void => {
      cleanup();
      reject(new HttpError(400, "Request aborted"));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAborted);
    req.once("error", onError);
  });
}

function sendText(
  res: http.ServerResponse,
  statusCode: number,
  body: string,
): void {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  maxBodyBytes: number,
): Promise<void> {
  const reqUrl = new URL(req.url || "/", "http://localhost");

  if (reqUrl.pathname === "/generate") {
    const mode = parseMode(reqUrl.searchParams.get("mode"));
    const seed = parseSeed(reqUrl.searchParams.get("seed"));

    const generator = new Generator({ mode, seed });
    const program = generator.generate();
    const source = printServerProgram(program);

    sendText(res, 200, source);
  } else if (reqUrl.pathname === "/mutate" && req.method === "POST") {
    // Structure-aware mutation of a posted JS testcase (e.g. a corpus
    // seed). On any failure the source is returned unmutated.
    const body = await readRequestBody(req, maxBodyBytes);
    const seed = parseSeed(reqUrl.searchParams.get("seed"));
    try {
      sendText(res, 200, mutateSource(body, seed));
    } catch {
      sendText(res, 200, body);
    }
  } else if (reqUrl.pathname === "/crossover" && req.method === "POST") {
    // Crossover: corpus seed (posted body) spliced with a freshly
    // generated program that can reference the seed's declarations.
    // On any failure the source is returned unchanged.
    const seed = parseSeed(reqUrl.searchParams.get("seed"));
    const body = await readRequestBody(req, maxBodyBytes);
    try {
      sendText(res, 200, crossoverSource(body, seed));
    } catch {
      sendText(res, 200, body);
    }
  } else if (reqUrl.pathname === "/lift" && req.method === "POST") {
    const body = await readRequestBody(req, maxBodyBytes);
    sendJson(res, 200, liftSource(body));
  } else if (reqUrl.pathname === "/roundtrip" && req.method === "POST") {
    const body = await readRequestBody(req, maxBodyBytes);
    const lifted = liftSource(body);
    const report = roundtripOk(body);
    sendJson(res, 200, {
      ok: report.ok,
      source_type: report.ok ? report.source_type : lifted.source_type,
      idempotent: report.ok ? report.idempotent : false,
      ast_faithful: report.ok ? report.ast_faithful : false,
      normalized: lifted.normalized,
      flags: lifted.flags,
    });
  } else {
    sendText(res, 404, "Not Found");
  }
}

function handleRequestError(error: unknown, res: http.ServerResponse): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy(error instanceof Error ? error : undefined);
    return;
  }
  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : String(error);
  sendText(
    res,
    statusCode,
    statusCode === 500 ? `Internal Server Error: ${message}` : message,
  );
}

export function createGeneratorServer(
  options: GeneratorServerOptions = {},
): http.Server {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) {
    throw new RangeError("maxBodyBytes must be a non-negative safe integer");
  }
  return http.createServer((req, res) => {
    void handleRequest(req, res, maxBodyBytes).catch((error: unknown) => {
      handleRequestError(error, res);
    });
  });
}

export function startGeneratorServer(
  port = parsePort(process.env.PORT),
): http.Server {
  const server = createGeneratorServer();
  server.listen(port, () => {
    console.log(`[ReconFuzz Daemon] AST Server listening on port ${port}`);
  });
  return server;
}

if (require.main === module) {
  const server = startGeneratorServer();
  server.on("error", (error) => {
    console.error(`[ReconFuzz Daemon] ${error.message}`);
    process.exitCode = 1;
  });
}
