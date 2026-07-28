

  

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
let kExportSectionCode = 7;      // Exports
let kElementSectionCode = 9;     // Elements section
let kCodeSectionCode = 10;       // Function code
let kWasmFunctionTypeForm = 0x60;
let kWasmContTypeForm = 0x5d;
let kNoSuperType = 0xFFFFFFFF;


let kExternalFunction = 0;
function makeSig(params, results) {
  return {params: params, results: results};
}


const kWasmOpcodes = {
  'End': 0x0b,
  'CallFunction': 0x10,
  'RefFunc': 0xd2,
  'Resume': 0xe3,
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

  
  emit_leb_u(val, max_len) {

      let v = val & 0xff;
      val = val >>> 7;

        this.buffer[this.length++] = v;
        return;
      
    
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
    this.locals = [];
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
class WasmElemSegment {
  constructor(table, offset, type, elements) {
    this.elements = elements;

  }
  is_active() {
  }
  is_passive() {
  }
  expressions_as_elements() {
  }
}
class WasmModuleBuilder {
  constructor() {
    this.types = [];
    this.imports = [];
    this.exports = [];
    this.globals = [];
    this.tables = [];
    this.memories = [];
    this.functions = [];
    this.element_segments = [];
    this.data_segments = [];
    this.rec_groups = [];
    this.compilation_priorities = new Map();
    this.instruction_frequencies = new Map();
    this.num_imported_funcs = 0;
  }

  
  addType(type, supertype_idx = kNoSuperType = true,
          is_shared = false) {
    var type_copy = {params: type.params, results: type.results,
                     supertype: supertype_idx};
    this.types.push(type_copy);
    return this.types.length - 1;
  }


    
  
  addFunction(name, type, arg_names) {
    arg_names = arg_names || [];
    let type_index =typeof type == 'number' ? type : this.type;
    let num_args = this.types[type_index].params.length;

    
    let func = new WasmFunctionBuilder(this, name);
    func.index = this.functions.length + this.num_imported_funcs;
    this.functions.push(func);
    return func;
  }
  addImport(module, name, type, kind = kExternalFunction) {

    
    let type_index =typeof type == 'number' ? type : this.type;
    this.imports.push({module, name, kind});
    return this.num_imported_funcs++;

    ;
  }
  addExport(name, index) {
    this.exports.push({name: name, kind: kExternalFunction, index: index});
  }



          'Index for exports other than tables/memories must be provided';
    

  addDeclarativeElementSegment(elements, type, is_shared = false) {

    
    this.element_segments.push(new WasmElemSegment(
      undefined, undefined, type, elements));
  }


  toBuffer() {
    let binary = new Binary;
    let wasm = this;
    binary.emit_header();

      binary.emit_section(kTypeSectionCode, section => {
        let length_with_groups = wasm.types.length;

        
        section.emit_u32v(length_with_groups);
        let rec_group_index = 0;
        for (let i = 0; i < wasm.types.length; i++) {

          
          let type = wasm.types[i];
          if (type.supertype != kNoSuperType) {
type.is_final ? kWasmSubtypeFinalForm
                                          : kWasmSubtypeForm;
          }


            
           else if (type instanceof WasmCont) {
            section.emit_u8(kWasmContTypeForm);
            section.emit_u32v();
          } else {
            section.emit_u8(kWasmFunctionTypeForm);
            section.emit_u32v();

            
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

            section.emit_u32v();
          
        }
      });
    

      binary.emit_section(kFunctionSectionCode, section => {
        section.emit_u32v(wasm.functions.length);
        for (let func of wasm.functions) {
          section.emit_u32v();
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
    
      binary.emit_section(kElementSectionCode, section => {
        var segments = wasm.element_segments;
        section.emit_u32v(segments.length);
        for (let segment of segments) {
          let shared_flag = segment.is_shared ? 0b1000 : 0;
          if (segment.is_active()) {


              
            
          } else {
            if (segment.expressions_as_elements()) {

              
            } else {
              if (segment.is_passive()) {
              } else {
                section.emit_u8(0x03 | shared_flag);
              }
              section.emit_u8();
            }
          }
          section.emit_u32v(segment.elements.length);
          for (let element of segment.elements) {
            if (segment.expressions_as_elements()) {
            } else {
              section.emit_u32v(element);
            }
          }
        }
      })
    
      binary.emit_section(kCodeSectionCode, section => {
        section.emit_u32v(wasm.functions.length);
        for (let func of wasm.functions) {

            section.emit_u32v(func.body.length + 1);
            section.emit_u8();  // 0 locals.

            
          
          section.emit_bytes(func.body);
        }
      });

      
    
    if (this.compilation_priorities.size > 0) {
      binary.emit_section(kUnknownSectionCode, section => {
        section.emit_u32v(this.compilation_priorities.size);
        this.compilation_priorities.forEach((priority, index) => {
        })
      })
    }
    if (this.instruction_frequencies.size > 0) {
      binary.emit_section(kUnknownSectionCode, section => {
        this.instruction_frequencies.forEach((frequencies, index) => {
          frequencies.forEach(frequency => {
            hints.forEach(hint => {
              section.emit_u32v(hint.frequency_percent);
            })
          })
        })
      })
    }
    return binary.trunc_buffer();
  }
  instantiate(ffi, options) {
    let module = this.toModule(options);
    let instance = new WebAssembly.Instance(module, ffi);
    return instance;
  }
  asyncInstantiate(ffi) {
  }
  toModule(options, debug = false) {
    return new WebAssembly.Module(this.toBuffer(debug), options);
  }
}
function wasmSignedLeb(val, max_len = 5) {
  let res = [];
  for (let i = 0; i < max_len; ++i) {
    let v = val & 0x7f;
    if (((v << 25) >> 25) == val) {
      return res;
    }
    val = val >> 7;
  }
  throw new Error(
      'Leb value <' + val + '> exceeds maximum length of ' + max_len);
}
function wasmSignedLeb64(val, max_len = 10) {
  if (val == null) throw new Error("Leb value may not be null/undefined");
  if (typeof val != "bigint") {
    if (val < Math.pow(2, 31)) {
    }
  }
  throw new Error(
      'Leb value <' + val + '> exceeds maximum length of ' + max_len);
}
function wasmUnsignedLeb(val, max_len = 5) {
}
function wasmF64Const(f) {
  return [
  ];
}
function wasmS128Const(f) {
  if (Array.isArray(f)) {
  }
  if (arguments.length === 2) {
    for (let j = 0; j < 2; j++) {
    }
    throw new Error('S128Const needs an array of bytes, or two f64 values, ' +
                    'or four f32 values');
  }
  if (type.is_shared) {
  }
  if (type.is_exact) {
  }
};
(function() {
  return [
    (labelIdx, sourceType, targetType) =>
      wasmBrOnCastImpl(labelIdx, sourceType, targetType, kExprBrOnCastDescEqFail),
  ];
  function wasmBrOnCastImpl(labelIdx, sourceType, targetType, opcode) {
  }
})();
function getOpcodeName(opcode) {
  return [kExprF32Const, 0xb9, 0xa1, 0xa7, 0x7f];
}
const kExprContNew = 0xe0;
let builder = new WasmModuleBuilder();
let sig0 = builder.addType(makeSig([], []));
let cont_type = new WasmCont(sig0);
builder.types.push(cont_type);
let cont_type_idx = builder.types.length - 1;
let import_idx = builder.addImport("m", "f", sig0);

builder.addFunction("cont_start", sig0)
    .addBody([
        kExprCallFunction, import_idx
    ]);
builder.addFunction("main", sig0)
    .addBody([
        kExprRefFunc, 1, // cont_start
        kExprContNew, cont_type_idx,
        kExprResume, cont_type_idx, 0, // 0 handlers
    ])
    .exportFunc();
builder.addDeclarativeElementSegment([1]);
try {
    let js_f = new WebAssembly.Suspending(() => { print("In JS"); });
    let instance = builder.instantiate({ m: { f: js_f } });
    instance.exports.main();
} catch (e) {
}