let o = new Array(1073741825);
o[0] = 1; // Force dictionary elements initially
let sep = {
  toString() {
    o.length = 0;
    o.push(1); // HOLEY_SMI_ELEMENTS
    return "";
  }
};
o.join(sep);
