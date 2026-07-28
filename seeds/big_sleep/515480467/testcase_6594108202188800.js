let worker_code = `
  onmessage = function(e) {
    function mul(a, b) {
      return a * b;
    }
    let large = 2n ** 100n;
    %PrepareFunctionForOptimization(mul);
    mul(large, large);
    %OptimizeFunctionOnNextCall(mul);
    let x = (2n ** 8000000n) - 1n;
    let y = (2n ** 8000000n) - 1n;
    postMessage("starting");
    mul(x, y);
  };
`;
  let w = new Worker(worker_code, {type: 'string'});
  w.postMessage("start");
  let msg = w.getMessage();