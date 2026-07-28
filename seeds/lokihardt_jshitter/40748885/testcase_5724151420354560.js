let PI = (async ( ...fill) => fill).bind(...new Array(65389));
function E() {
    return PI();
}
E();
%OptimizeFunctionOnNextCall(E);
E();