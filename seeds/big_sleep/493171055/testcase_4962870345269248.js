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
let kWasmRefNull = 0x63;
class RefTypeBuilder {
  constructor(opcode, heap_type) {
    this.opcode = opcode;
    this.heap_type = heap_type;
  }
}
function wasmRefNullType(heap_type) {
  return new RefTypeBuilder(kWasmRefNull, heap_type);
}
let kExternalFunction = 0;
let kSig_v_v = makeSig([], []);
function makeSig(params, results) {
  return {params: params, results: results};
}
const kWasmOpcodes = {
  'Throw': 0x08,
  'End': 0x0b,
  'RefFunc': 0xd2,
  'ContNew': 0xe0,
};
function defineWasmOpcode(name, value) {
    globalThis.kWasmOpcodeNames = {};
  Object.defineProperty(globalThis, name, {value: value});
`Duplicate wasm opcode: ${value}. Previous name: ${
        globalThis.kWasmOpcodeNames[value]}, new name: ${name}`;
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
  emit_heap_type(heap_type) {
    this.emit_bytes(wasmSignedLeb(heap_type));
  }
  emit_type(type) {
    if ((typeof type) == 'number') {
    } else {
      this.emit_u8(type.opcode);
      this.emit_heap_type(type.heap_type);
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
  constructor(module, name) {
    this.module = module;
    this.name = name;
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
  addFunction(name) {
    let func = new WasmFunctionBuilder(this, name);
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
            section.emit_u32v();
          }
        }
      });
      binary.emit_section(kFunctionSectionCode, section => {
        section.emit_u32v(wasm.functions.length);
          section.emit_u32v();
      });
      binary.emit_section(kTagSectionCode, section => {
        section.emit_u32v(wasm.tags.length);
        for (let type_index of wasm.tags) {
          section.emit_u32v();
          section.emit_u32v(type_index);
        }
      });
    var exports_count = wasm.exports.length;
      binary.emit_section(kExportSectionCode, section => {
        section.emit_u32v(exports_count);
        for (let exp of wasm.exports) {
          section.emit_string(exp.name);
          section.emit_u8();
          section.emit_u32v();
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
function wasmSignedLeb(val = 5) {
  let res = [];
    let v = val & 0x7f;
      res.push(v);
      return res;
}
let builder = new WasmModuleBuilder();
let sig_v_v = builder.addType(kSig_v_v);
let cont_index = builder.addCont();
let tag_index = builder.addTag(makeSig([wasmRefNullType(cont_index)], []));
builder.addFunction("throw_cont").addBody([
    kExprRefFunc, 0,
    kExprContNew, cont_index,
    kExprThrow, tag_index
]).exportFunc();
let instance = builder.instantiate();
try {
    instance.exports.throw_cont();
} catch (e) {
    let values = %GetWasmExceptionValues(e);
    let cont = values[0];
    Object.keys(cont);
}