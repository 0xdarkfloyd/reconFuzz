  Object.defineProperty(Object.prototype, "total_committed_bytes", {
    set: function() {
      getV8Statistics();
    },
  });
  getV8Statistics();