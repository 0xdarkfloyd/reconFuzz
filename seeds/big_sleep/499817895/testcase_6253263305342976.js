// Flags: --allow-natives-syntax
const v0 = `
    using v1 = { [Symbol.dispose]: () => {} };
    eval('v1');
`;
%RuntimeEvaluateREPL(v0);
