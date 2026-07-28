import * as http from 'http';
import { URL } from 'url';
import { Generator, printProgram, GeneratorConfig } from './index';

const PORT = parseInt(process.env.PORT || '3000', 10);

const server = http.createServer((req, res) => {
  try {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    
    if (reqUrl.pathname === '/generate') {
      const mode = (reqUrl.searchParams.get('mode') as GeneratorConfig['mode']) || 'hybrid';
      const rawSeed = reqUrl.searchParams.get('seed');
      const seed = rawSeed ? parseInt(rawSeed, 10) : Math.floor(Math.random() * 2**31);

      const generator = new Generator({ mode, seed });
      const program = generator.generate();
      const source = printProgram(program);

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(source);
    } else {
      res.writeHead(404, {'Content-Type': 'text/plain'});
      res.end('Not Found');
    }
  } catch (error) {
    res.writeHead(500, {'Content-Type': 'text/plain'});
    res.end(`Internal Server Error: ${error}`);
  }
});

server.listen(PORT, () => {
  console.log(`[ReconFuzz Daemon] AST Server listening on port ${PORT}`);
});
