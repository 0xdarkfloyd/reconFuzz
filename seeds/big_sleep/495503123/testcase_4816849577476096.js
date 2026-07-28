// Flags: --module
print("Start");
let p = Promise.reject("original error");
p.catch();
try {
  print("Awaiting rejection...");
  await p;
} finally {
  print("Terminating in finally...");
  d8.terminateNow();
}
print("End");
