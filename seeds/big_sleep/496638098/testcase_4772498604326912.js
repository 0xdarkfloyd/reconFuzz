const size = 270 * 1024 * 1024;
const code = " ".repeat(size) + "import 'data:text/javascript,export {}'; export {}";
import("data:text/javascript," + code).catch();