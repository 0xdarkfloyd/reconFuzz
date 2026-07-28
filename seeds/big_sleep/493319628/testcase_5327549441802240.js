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
let kTableSectionCode = 4;       // Indirect function table and other tables
let kExportSectionCode = 7;      // Exports
let kCodeSectionCode = 10;       // Function code
let kWasmFunctionTypeForm = 0x60;
let kNoSuperType = 0xFFFFFFFF;
let kWasmI32 = 0x7f;
let kWasmFuncRef = -0x10;
let kWasmAnyFunc = kWasmFuncRef;  // Alias named as in the JS API spec
let kLeb128Mask = 0x7f;
let kExternalFunction = 0;
let kSig_i_i = makeSig([kWasmI32], [kWasmI32]);
let kSig_i_v = makeSig([], [kWasmI32]);
function makeSig(params, results) {
  return {params: params, results: results};
}
const kWasmOpcodes = {
  'Nop': 0x01,
  'If': 0x04,
  'Else': 0x05,
  'End': 0x0b,
  'CallFunction': 0x10,
  'CallIndirect': 0x11,
  'Drop': 0x1a,
  'I32Const': 0x41,
};
function defineWasmOpcode(name, value) {
  Object.defineProperty(globalThis, name, {value: value});
}
for (let name in kWasmOpcodes) {
  defineWasmOpcode(`kExpr${name}`, kWasmOpcodes[name]);
}
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
  emit_type(type) {
      this.emit_u8(type >= 0 ? type : type & kLeb128Mask);
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
  constructor(module, type_index) {
    this.module = module;
  }
  exportAs(name) {
    this.module.addExport(name, this.index);
  }
  addBody(body) {
    this.body = body.concat([kExprEnd]);
    return this;
  }
}
class WasmTableBuilder {
  constructor(module, type) {
    this.type = type;
  }
}
class WasmModuleBuilder {
  constructor() {
    this.types = [];
    this.imports = [];
    this.exports = [];
    this.tables = [];
    this.functions = [];
    this.explicit = [];
    this.num_imported_funcs = 0;
  }
  stringToBytes(name) {
    var result = new Binary();
    result.emit_u32v(name.length);
    for (var i = 0; i < name.length; i++) {
      result.emit_u8(name.charCodeAt(i));
    }
    return result.trunc_buffer()
  }
  createCustomSection(name, bytes) {
    name = this.stringToBytes(name);
    var section = new Binary();
    section.emit_u8();
    section.emit_u32v(name.length + bytes.length);
    section.emit_bytes(name);
    section.emit_bytes(bytes);
    return section.trunc_buffer();
  }
  addCustomSection(name, bytes) {
    this.explicit.push(this.createCustomSection(name, bytes));
  }
  addType(type, supertype_idx = kNoSuperType = true,
          is_shared = false) {
    var type_copy = {params: type.params, results: type.results,
                     supertype: supertype_idx};
    this.types.push(type_copy);
  }
  addTable(
      type =  init_expr = 
      is_shared =  is_table64 = false) {
    let table = new WasmTableBuilder(
        this, type);
    this.tables.push(table);
  }
  addFunction(name, type, arg_names) {
    let func = new WasmFunctionBuilder(this);
    func.index = this.functions.length + this.num_imported_funcs;
    this.functions.push(func);
    return func;
  }
  addImport(module, name, kind = kExternalFunction) {
    this.imports.push({module, name});
  }
  addExport(name, index) {
    this.exports.push({name: name, kind: kExternalFunction, index: index});
  }
  setTableBounds() {
    this.addTable(kWasmAnyFunc);
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
          } else {
            section.emit_u8(kWasmFunctionTypeForm);
            section.emit_u32v(type.params.length);
            for (let param of type.params) {
              section.emit_type(param);
            }
            section.emit_u32v(type.results.length);
            for (let result of type.results) {
              section.emit_type(result);
            }
          }
        }
      });
      binary.emit_section(kImportSectionCode, section => {
        section.emit_u32v(wasm.imports.length);
        for (let imp of wasm.imports) {
          section.emit_string(imp.module);
          section.emit_string(imp.name || '');
          section.emit_u8();
            section.emit_u32v();
        }
      });
      binary.emit_section(kFunctionSectionCode, section => {
        section.emit_u32v(wasm.functions.length);
        for (let func of wasm.functions) {
          section.emit_u32v();
        }
      });
      binary.emit_section(kTableSectionCode, section => {
        section.emit_u32v(wasm.tables.length);
        for (let table of wasm.tables) {
          section.emit_type(table.type);
          section.emit_u8();
          let emit = val => table.is_table64 ? section.val :
                                               section.emit_u32v();
          emit();
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
    for (let exp of wasm.explicit) {
      binary.emit_bytes(exp);
    }
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
const builder = new WasmModuleBuilder();
const type0 = builder.addType(kSig_i_v);
builder.addImport("m", "f");
builder.setTableBounds();
builder.addFunction("f1", type0)
  .addBody([kExprI32Const, kExprNop]);
const num_calls = 100;
const body = [];
const instr_freq_payload = new Binary();
const call_targets_payload = new Binary();
instr_freq_payload.emit_u32v(1); // num functions
instr_freq_payload.emit_u32v(2); // func index 2 (main)
instr_freq_payload.emit_u32v(num_calls);
call_targets_payload.emit_u32v(1); // num functions
call_targets_payload.emit_u32v(2); // func index 2
call_targets_payload.emit_u32v(num_calls);
for (let i = 0; i < num_calls; i++) {
  const offset = 1 + i * 6;
  body.push( 0, kExprCallIndirect, 0, 0, kExprDrop);
  const call_site_offset = offset + 2;
  instr_freq_payload.emit_u32v(call_site_offset);
  instr_freq_payload.emit_u32v(1);
  instr_freq_payload.emit_u8(32);
  const target =i % 2 == 0 ? 1000 : 1;
  const target_bin = new Binary();
  target_bin.emit_u32v(target);
  target_bin.emit_u32v();
  call_targets_payload.emit_u32v(call_site_offset);
  call_targets_payload.emit_u32v(target_bin.length);
  call_targets_payload.emit_bytes(target_bin.trunc_buffer());
}
builder.addFunction("main", type0).addBody(body); // index 2
builder.addFunction("top", kSig_i_i)
  .addBody([
    ,
    kExprIf, kWasmI32,
      kExprCallFunction, 2, // call main
    kExprElse, 0,
    kExprEnd
  ])
  .exportAs("top");
builder.addCustomSection("metadata.code.instr_freq", instr_freq_payload.trunc_buffer());
builder.addCustomSection("metadata.code.call_targets", call_targets_payload.trunc_buffer());
const instance = builder.instantiate({ m: { f: () => 1 } });
for (let i = 0; i < 10; i++) instance.exports.top();