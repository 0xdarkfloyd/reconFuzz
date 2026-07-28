var kWasmH0 = 0;
var kWasmH1 = 0x61;
var kWasmH2 = 0x73;
var kWasmH3 = 0x6d;
var kWasmV0 = 0x1;
var kWasmV1 = 0;
var kWasmV2 = 0;
var kWasmV3 = 0;
var kMaxVarInt32Size = 5;
let kTypeSectionCode = 1;        // Function signature declarations
let kImportSectionCode = 2;      // Import declarations
let kFunctionSectionCode = 3;    // Function declarations
let kGlobalSectionCode = 6;      // Global declarations
let kExportSectionCode = 7;      // Exports
let kCodeSectionCode = 10;       // Function code
let kWasmFunctionTypeForm = 0x60;
let kWasmContTypeForm = 0x5d;
let kNoSuperType = 0xFFFFFFFF;
let kWasmI32 = 0x7f;
let kWasmFuncRef = -0x10;
let kLeb128Mask = 0x7f;
let kWasmRefNull = 0x63;
let kWasmRef = 0x64;
class RefTypeBuilder {
  constructor(opcode, heap_type) {
    this.opcode = opcode;
    this.heap_type = heap_type;
  }
}
function wasmRefNullType(heap_type) {
  return new RefTypeBuilder(kWasmRefNull, heap_type);
}
function wasmRefType(heap_type) {
  return new RefTypeBuilder(kWasmRef, heap_type);
}
let kExternalFunction = 0;
function makeSig(params, results) {
  return {params: params, results: results};
}
const kWasmOpcodes = {
  'End': 0x0b,
  'CallFunction': 0x10,
  'LocalGet': 0x20,
  'GlobalGet': 0x23,
  'GlobalSet': 0x24,
  'I32Const': 0x41,
  'RefNull': 0xd0,
  'ContNew': 0xe0,
  'Resume': 0xe3,
};
function defineWasmOpcode(name, value) {
  Object.defineProperty(globalThis, name, {value: value});
}
for (let name in kWasmOpcodes) {
  defineWasmOpcode(`kExpr${name}`, kWasmOpcodes[name]);
}
const kPrefixOpcodes = {
  'GC': 0xfb,
};
for (let prefix in kPrefixOpcodes) {
  defineWasmOpcode(`k${prefix}Prefix`, kPrefixOpcodes[prefix]);
}
let kExprRefCast = 0x16;
class Binary {
  constructor() {
    this.length = 0;
    this.buffer = new Uint8Array(8192);
  }
  trunc_buffer() {
    return new Uint8Array(this.buffer.buffer, 0, this.length);
  }
  emit_u8(val) {
    this.buffer[this.length++] = val;
  }
  emit_leb_u(val, max_len) {
    for (let i = 0; i < max_len; ++i) {
      let v = val & 0xff;
      val = val >>> 7;
      if (val == 0) {
        this.buffer[this.length++] = v;
        return;
      }
      this.buffer[this.length++] = v | 0x80;
    }
  }
  emit_u32v(val) {
    this.emit_leb_u(val, kMaxVarInt32Size);
  }
  emit_bytes(data) {
    this.buffer.set(data, this.length);
    this.length += data.length;
  }
  emit_string(string) {
    let string_utf8 = string;
    this.emit_u32v(string_utf8.length);
    for (let i = 0; i < string_utf8.length; i++) {
      this.emit_u8(string_utf8.charCodeAt(i));
    }
  }
  emit_heap_type(heap_type) {
    this.emit_bytes(wasmSignedLeb(heap_type));
  }
  emit_type(type) {
    if ((typeof type) == 'number') {
      this.emit_u8(type >= 0 ? type : type & kLeb128Mask);
    } else {
      this.emit_u8(type.opcode);
      this.emit_heap_type(type.heap_type);
    }
  }
  emit_init_expr(expr) {
    this.emit_bytes(expr);
    this.emit_u8(kExprEnd);
  }
  emit_header() {
    this.emit_bytes([
      kWasmH0, kWasmH1, kWasmH2, kWasmH3, kWasmV0, kWasmV1, kWasmV2, kWasmV3
    ]);
  }
  emit_section(section_code, content_generator) {
    this.emit_u8(section_code);
    const section = new Binary;
    content_generator(section);
    this.emit_u32v(section.length);
    this.emit_bytes(section.trunc_buffer());
  }
}
class WasmFunctionBuilder {
  constructor(module, name, type_index) {
    this.module = module;
    this.name = name;
    this.type_index = type_index;
  }
  exportAs(name) {
    this.module.addExport(name, this.index);
  }
  exportFunc() {
    this.exportAs(this.name);
  }
  addBody(body) {
    this.body = body.concat([kExprEnd]);
    return this;
  }
}
class WasmGlobalBuilder {
  constructor(module, type, mutable, shared, init) {
    this.type = type;
    this.mutable = mutable;
    this.init = init;
  }
}
class WasmCont {
  constructor() {
    this.supertype = kNoSuperType;
  }
}
class WasmModuleBuilder {
  constructor() {
    this.types = [];
    this.imports = [];
    this.exports = [];
    this.globals = [];
    this.functions = [];
    this.num_imported_funcs = 0;
  }
  addType(type, supertype_idx = kNoSuperType = true,
          is_shared = false) {
    var type_copy = {params: type.params, results: type.results,
                     supertype: supertype_idx};
    this.types.push(type_copy);
    return this.types.length - 1;
  }
  addCont() {
    this.types.push(new WasmCont());
    return this.types.length - 1;
  }
  addGlobal(type, mutable, shared, init) {
    let glob = new WasmGlobalBuilder(this, type, mutable, shared, init);
    this.globals.push(glob);
    return glob;
  }
  addFunction(name, type) {
    let type_index =typeof type == 'number' ? type : this.addType(type);
    let func = new WasmFunctionBuilder(this, name, type_index);
    func.index = this.functions.length + this.num_imported_funcs;
    this.functions.push(func);
    return func;
  }
  addImport(module, name, type, kind = kExternalFunction) {
    let type_index =typeof type == 'number' ? type : this.type;
    this.imports.push({module, name, type_index});
    return this.num_imported_funcs++;
  }
  addExport(name, index) {
    this.exports.push({name: name, kind: kExternalFunction, index: index});
  }
  toBuffer() {
    let binary = new Binary;
    let wasm = this;
    binary.emit_header();
      binary.emit_section(kTypeSectionCode, section => {
        let length_with_groups = wasm.types.length;
        section.emit_u32v(length_with_groups);
        for (let i = 0; i < wasm.types.length; i++) {
          let type = wasm.types[i];
          if (type.supertype != kNoSuperType) {
          } else if (type instanceof WasmCont) {
            section.emit_u8(kWasmContTypeForm);
            section.emit_u32v();
          } else {
            section.emit_u8(kWasmFunctionTypeForm);
            section.emit_u32v(type.params.length);
            for (let param of type.params) {
              section.emit_type(param);
            }
            section.emit_u32v();
          }
        }
      });
      binary.emit_section(kImportSectionCode, section => {
        section.emit_u32v(wasm.imports.length);
        for (let imp of wasm.imports) {
          section.emit_string(imp.module);
          section.emit_string(imp.name || '');
          section.emit_u8();
            section.emit_u32v(imp.type_index);
        }
      });
      binary.emit_section(kFunctionSectionCode, section => {
        section.emit_u32v(wasm.functions.length);
        for (let func of wasm.functions) {
          section.emit_u32v(func.type_index);
        }
      });
      binary.emit_section(kGlobalSectionCode, section => {
        section.emit_u32v(wasm.globals.length);
        for (let global of wasm.globals) {
          section.emit_type(global.type);
          section.emit_u8((global.mutable ? 1 : 0) | (global.shared ? 0b10 : 0));
          section.emit_init_expr(global.init);
        }
      });
    var exports_count = wasm.exports.length;
      binary.emit_section(kExportSectionCode, section => {
        section.emit_u32v(exports_count);
        for (let exp of wasm.exports) {
          section.emit_string(exp.name);
          section.emit_u8();
          section.emit_u32v(exp.index);
        }
      });
      binary.emit_section(kCodeSectionCode, section => {
        section.emit_u32v(wasm.functions.length);
        for (let func of wasm.functions) {
            section.emit_u32v(func.body.length + 1);
            section.emit_u8();  // 0 locals.
          section.emit_bytes(func.body);
        }
      });
    return binary.trunc_buffer();
  }
  instantiate(ffi) {
    let module = this.toModule();
    let instance = new WebAssembly.Instance(module, ffi);
    return instance;
  }
  toModule() {
    return new WebAssembly.Module(this.toBuffer());
  }
}
function wasmSignedLeb(val = 5) {
  let res = [];
    let v = val & 0x7f;
      res.push(v);
      return res;
}
function makeModuleB() {
    let b = new WasmModuleBuilder();
    let params = new Array(100).fill(kWasmI32);
    let sig = b.addType(makeSig(params, []));
    let cont = b.addCont();
    let global = b.addGlobal(wasmRefNullType(cont), true, false, [kExprRefNull, cont]);
    b.addFunction("f", sig).addBody([]).exportFunc();
    b.addFunction("store", makeSig([wasmRefType(cont)], []))
        .addBody([kExprLocalGet, 0, kExprGlobalSet, global.index])
        .exportFunc();
    let resume_body = [];
    for (let i = 0; i < 100; i++) resume_body.push(kExprI32Const, i);
    resume_body.push(kExprGlobalGet, global. kExprRefAsNonNull);
    resume_body.push(kExprResume, cont, 0);
    b.addFunction("resume", makeSig([], []))
        .addBody(resume_body)
        .exportFunc();
    return b.instantiate();
}
function makeModuleA() {
    let b = new WasmModuleBuilder();
    let params = new Array(100).fill(kWasmI32);
    let sig = b.addType(makeSig(params, []));
    let cont = b.addCont();
    let store_sig = b.addType(makeSig([wasmRefType(cont)], []));
    let import_idx = b.addImport("m", "store", store_sig);
    b.addFunction("go", makeSig([kWasmFuncRef], []))
        .addBody([
            kExprLocalGet, 0,
            kGCPrefix, kExprRefCast, sig,
            kExprContNew, cont,
            kExprCallFunction, import_idx
        ])
        .exportFunc();
    return b.instantiate({m: {store: instanceB.exports.store}});
}
    let instanceB = makeModuleB();
    let instanceA = makeModuleA();
    instanceA.exports.go(instanceB.exports.f);
    instanceA = null;
        let body = [];
        for (let j = 0; j < 100; j++) body.push();
    gc();
        instanceB.exports.resume();