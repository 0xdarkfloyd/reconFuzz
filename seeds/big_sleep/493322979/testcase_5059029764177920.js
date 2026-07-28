var kWasmH0 = 0;
var kWasmH1 = 0x61;
var kWasmH2 = 0x73;
var kWasmH3 = 0x6d;
var kWasmV0 = 0x1;
var kWasmV1 = 0;
var kWasmV2 = 0;
var kWasmV3 = 0;
let kTypeSectionCode = 1;        // Function signature declarations
let kFunctionSectionCode = 3;    // Function declarations
let kExportSectionCode = 7;      // Exports
let kCodeSectionCode = 10;       // Function code
let kTagSectionCode = 13;        // Tag section (between Memory & Global)
let kWasmFunctionTypeForm = 0x60;
let kWasmContTypeForm = 0x5d;
let kNoSuperType = 0xFFFFFFFF;
let kWasmI32 = 0x7f;
let kWasmRefNull = 0x63;
let kWasmRef = 0x64;
class RefTypeBuilder {
  constructor(opcode) {
    this.opcode = opcode;
  }
}
function wasmRefNullType() {
  return new RefTypeBuilder(kWasmRefNull);
}
let kExternalFunction = 0;
let kSig_v_v = makeSig([], []);
function makeSig(params, results) {
  return {params: params, results: results};
}
const kWasmOpcodes = {
  'Block': 0x02,
  'End': 0x0b,
  'Drop': 0x1a,
  'LocalGet': 0x20,
  'I32Const': 0x41,
  'ContNew': 0xe0,
  'Suspend': 0xe2,
  'Resume': 0xe3,
};
function defineWasmOpcode(name, value) {
  Object.defineProperty(globalThis, name, {value: value});
}
for (let name in kWasmOpcodes) {
  defineWasmOpcode(`kExpr${name}`, kWasmOpcodes[name]);
}
let kOnSuspend = 0x0;
let kOnSwitch = 0x1;
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
  emit_leb_u(val) {
      let v = val & 0xff;
        this.buffer[this.length++] = v;
  }
  emit_u32v(val) {
    this.emit_leb_u(val);
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
  emit_heap_type() {
    this.emit_bytes(wasmSignedLeb());
  }
  emit_type(type) {
    if ((typeof type) == 'number') {
      this.emit_u8(type >= 0 ? type : type & kLeb128Mask);
    } else {
      this.emit_u8(type.opcode);
      this.emit_heap_type();
    }
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
class WasmCont {
  constructor() {
    this.supertype = kNoSuperType;
  }
}
class WasmModuleBuilder {
  constructor() {
    this.types = [];
    this.exports = [];
    this.tags = [];
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
  addTag(type) {
    let type_index =typeof type == 'number' ? type : this.addType(type);
    this.tags.push(type_index);
  }
  addFunction(name, type) {
    let type_index =typeof type == 'number' ? type : this.type;
    let func = new WasmFunctionBuilder(this, name, type_index);
    func.index = this.functions.length + this.num_imported_funcs;
    this.functions.push(func);
    return func;
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
            section.emit_u32v(type.results.length);
            for (let result of type.results) {
              section.emit_type(result);
            }
          }
        }
      });
      binary.emit_section(kFunctionSectionCode, section => {
        section.emit_u32v(wasm.functions.length);
        for (let func of wasm.functions) {
          section.emit_u32v(func.type_index);
        }
      });
      binary.emit_section(kTagSectionCode, section => {
        section.emit_u32v(wasm.tags.length);
          section.emit_u32v();
          section.emit_u32v();
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
  instantiate() {
    let module = this.toModule();
    let instance = new WebAssembly.Instance(module);
    return instance;
  }
  toModule() {
    return new WebAssembly.Module(this.toBuffer());
  }
}
function wasmSignedLeb(val, max_len = 5) {
  let res = [];
    let v = val & 0x7f;
      res.push(v);
      return res;
};
const builder = new WasmModuleBuilder();
let tag0 = builder.kSig_v_v;
let tag1 = builder.addTag(kSig_v_v);
let cont = builder.addCont();
builder.addFunction("suspend_func")
    .addBody([kExprSuspend, tag0]).exportFunc();
let resume_sig = builder.addType(makeSig([wasmRefNullType()], [kWasmI32]));
builder.addFunction('resume_func', resume_sig)
    .addBody([
      kExprBlock, kWasmRef, cont,
          kExprLocalGet, 0,
          kExprContNew, cont,
          kExprResume, cont, 2,
            kOnSwitch, tag1, 0,
            kOnSuspend, tag0, 0,
      kExprEnd,
      kExprDrop,
      kExprI32Const, 2,
    ]).exportFunc();
    let instance = builder.instantiate();
    instance.exports.resume_func(instance.exports.suspend_func);