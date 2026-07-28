try {
  var pre = "(?:(?:" + "a".repeat(5461) + "){2}){3}";
  var re = new RegExp("(?<=bb" + pre + ")c");
  print("Regex compiled");
  re.exec("bb" + "a".repeat() + "c");
  print("Done");
} catch (e) {
  print("Error: " + e);
}
