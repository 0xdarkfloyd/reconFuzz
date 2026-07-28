// Flags: --js-decorators
try {
  class C {
    accessor async [ ) ]
  }
} catch (e) {}
