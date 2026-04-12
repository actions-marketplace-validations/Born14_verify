"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/gates/infrastructure.ts
var infrastructure_exports = {};
__export(infrastructure_exports, {
  compareManifest: () => compareManifest,
  countDependents: () => countDependents,
  findAndParseState: () => findAndParseState,
  findInfraDir: () => findInfraDir,
  findResource: () => findResource,
  flattenAttributes: () => flattenAttributes,
  getAttribute: () => getAttribute,
  infraPredicateFingerprint: () => infraPredicateFingerprint,
  loadManifest: () => loadManifest,
  parseTerraformState: () => parseTerraformState,
  runInfrastructureGate: () => runInfrastructureGate
});
function parseTerraformState(raw) {
  const state = JSON.parse(raw);
  const resources = [];
  for (const res of state.resources ?? []) {
    const address = `${res.type}.${res.name}`;
    for (const instance of res.instances ?? []) {
      const attrs = instance.attributes ?? {};
      const flat = flattenAttributes(attrs);
      resources.push({
        address,
        type: res.type,
        id: flat.id ?? flat.identifier ?? address,
        attributes: flat
      });
    }
  }
  return {
    resources,
    version: state.version,
    toolVersion: state.terraform_version
  };
}
function flattenAttributes(obj, prefix = "") {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    result[fullKey] = value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(result, flattenAttributes(value, fullKey));
    }
  }
  return result;
}
function findAndParseState(infraDir) {
  const candidates = [
    "terraform.tfstate",
    "terraform.tfstate.backup",
    "pulumi.state.json"
  ];
  for (const name of candidates) {
    const filePath = (0, import_path3.join)(infraDir, name);
    if ((0, import_fs3.existsSync)(filePath)) {
      try {
        const raw = (0, import_fs3.readFileSync)(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.version !== void 0 && parsed.resources) {
          return parseTerraformState(raw);
        }
      } catch {
      }
    }
  }
  return void 0;
}
function loadManifest(infraDir, fileName = "manifest.json") {
  const filePath = (0, import_path3.join)(infraDir, fileName);
  if (!(0, import_fs3.existsSync)(filePath)) return void 0;
  try {
    return JSON.parse((0, import_fs3.readFileSync)(filePath, "utf-8"));
  } catch {
    return void 0;
  }
}
function findResource(state, address) {
  return state.resources.find((r) => r.address === address);
}
function getAttribute(resource, attributePath) {
  if (attributePath in resource.attributes) {
    return resource.attributes[attributePath];
  }
  const parts = attributePath.split(".");
  let current = resource.attributes;
  for (const part of parts) {
    if (current === null || current === void 0) return void 0;
    if (typeof current !== "object") return void 0;
    current = current[part];
  }
  return current;
}
function countDependents(state, targetAddresses) {
  const targetIds = /* @__PURE__ */ new Set();
  for (const addr of targetAddresses) {
    const res = findResource(state, addr);
    if (res) targetIds.add(String(res.attributes.id ?? ""));
  }
  const dependents = [];
  for (const res of state.resources) {
    if (targetAddresses.includes(res.address)) continue;
    for (const [key, value] of Object.entries(res.attributes)) {
      if (typeof value === "string" && targetIds.has(value) && (key.endsWith("_id") || key === "cluster" || key === "vpc_id")) {
        dependents.push(res.address);
        break;
      }
    }
  }
  return {
    directCount: targetAddresses.length,
    dependentCount: dependents.length,
    dependents
  };
}
function compareManifest(state, manifest) {
  const drifts = [];
  for (const expected of manifest.resources) {
    const actual = findResource(state, expected.address);
    if (!actual) {
      drifts.push({
        address: expected.address,
        type: "missing",
        critical: expected.critical,
        detail: `Resource ${expected.address} exists in manifest but not in state`
      });
      continue;
    }
    for (const [attrPath, expectedValue] of Object.entries(expected.attributes)) {
      const actualValue = getAttribute(actual, attrPath);
      const actualStr = String(actualValue ?? "");
      const expectedStr = String(expectedValue);
      if (actualStr !== expectedStr) {
        drifts.push({
          address: expected.address,
          type: "attribute_drift",
          critical: expected.critical,
          detail: `${expected.address}.${attrPath}: expected "${expectedStr}", got "${actualStr}"`,
          attribute: attrPath,
          expected: expectedStr,
          actual: actualStr
        });
      }
    }
  }
  for (const res of state.resources) {
    const inManifest = manifest.resources.some((m) => m.address === res.address);
    if (!inManifest) {
      drifts.push({
        address: res.address,
        type: "orphan",
        critical: false,
        detail: `Resource ${res.address} exists in state but not in manifest`
      });
    }
  }
  return drifts;
}
function runInfrastructureGate(ctx) {
  const start = Date.now();
  const infraPreds = ctx.predicates.filter(
    (p) => p.type === "infra_resource" || p.type === "infra_attribute" || p.type === "infra_manifest"
  );
  if (infraPreds.length === 0) {
    return {
      gate: "infrastructure",
      passed: true,
      detail: "No infrastructure predicates to check",
      durationMs: Date.now() - start,
      predicateResults: []
    };
  }
  const state = ctx.grounding?.infraState;
  if (!state) {
    return {
      gate: "infrastructure",
      passed: false,
      detail: "No infrastructure state available (no terraform.tfstate or equivalent found)",
      durationMs: Date.now() - start,
      predicateResults: infraPreds.map((p, i) => ({
        predicateId: `infra_p${i}`,
        type: p.type,
        passed: false,
        expected: describeExpected(p),
        actual: "(no state file)",
        fingerprint: infraPredicateFingerprint(p)
      }))
    };
  }
  let manifest;
  const manifestPreds = infraPreds.filter((p) => p.type === "infra_manifest");
  if (manifestPreds.length > 0 && ctx.config.appDir) {
    const infraDir = findInfraDir(ctx.config.appDir);
    if (infraDir) manifest = loadManifest(infraDir);
  }
  const results = [];
  let allPassed = true;
  const details = [];
  for (let i = 0; i < infraPreds.length; i++) {
    const p = infraPreds[i];
    const result = validateInfraPredicate(p, state, manifest);
    results.push({ ...result, predicateId: `infra_p${i}` });
    if (!result.passed) {
      allPassed = false;
      details.push(`${p.type}: ${result.actual ?? "failed"}`);
    }
  }
  const passCount = results.filter((r) => r.passed).length;
  const detail = allPassed ? `All ${infraPreds.length} infrastructure predicates passed` : `${passCount}/${infraPreds.length} passed: ${details.join("; ")}`;
  ctx.log(`[infrastructure] ${detail}`);
  return {
    gate: "infrastructure",
    passed: allPassed,
    detail,
    durationMs: Date.now() - start,
    predicateResults: results
  };
}
function validateInfraPredicate(p, state, manifest) {
  const fingerprint = infraPredicateFingerprint(p);
  if (p.type === "infra_resource" && p.resource) {
    const resource = findResource(state, p.resource);
    const assertion = p.assertion ?? "exists";
    if (assertion === "exists") {
      return {
        type: "infra_resource",
        passed: !!resource,
        expected: `${p.resource} exists`,
        actual: resource ? `${p.resource} found (id: ${resource.id})` : `${p.resource} not found`,
        fingerprint
      };
    }
    if (assertion === "absent") {
      return {
        type: "infra_resource",
        passed: !resource,
        expected: `${p.resource} absent`,
        actual: resource ? `${p.resource} still exists (id: ${resource.id})` : `${p.resource} absent`,
        fingerprint
      };
    }
  }
  if (p.type === "infra_attribute" && p.resource && p.attribute) {
    const resource = findResource(state, p.resource);
    if (!resource) {
      return {
        type: "infra_attribute",
        passed: false,
        expected: `${p.resource}.${p.attribute} == ${p.expected}`,
        actual: `resource ${p.resource} not found`,
        fingerprint
      };
    }
    const actualValue = getAttribute(resource, p.attribute);
    const actualStr = actualValue === void 0 ? "(undefined)" : String(actualValue);
    const expectedStr = p.expected ?? "exists";
    if (expectedStr === "exists") {
      return {
        type: "infra_attribute",
        passed: actualValue !== void 0 && actualValue !== null,
        expected: `${p.attribute} exists`,
        actual: actualStr,
        fingerprint
      };
    }
    const passed = actualStr === expectedStr;
    return {
      type: "infra_attribute",
      passed,
      expected: expectedStr,
      actual: actualStr,
      fingerprint
    };
  }
  if (p.type === "infra_manifest") {
    if (!manifest) {
      return {
        type: "infra_manifest",
        passed: false,
        expected: "state matches manifest",
        actual: "no manifest file found",
        fingerprint
      };
    }
    const assertion = p.assertion ?? "matches_manifest";
    const drifts = compareManifest(state, manifest);
    if (assertion === "matches_manifest") {
      const passed = drifts.length === 0;
      return {
        type: "infra_manifest",
        passed,
        expected: "state matches manifest (0 drifts)",
        actual: passed ? "state matches manifest" : `${drifts.length} drift(s): ${drifts.slice(0, 3).map((d) => d.detail).join("; ")}`,
        fingerprint
      };
    }
    if (assertion === "no_production_drift") {
      const criticalDrifts = drifts.filter((d) => d.critical);
      const passed = criticalDrifts.length === 0;
      return {
        type: "infra_manifest",
        passed,
        expected: "no production-critical drift",
        actual: passed ? "no critical drift" : `${criticalDrifts.length} critical drift(s): ${criticalDrifts.slice(0, 3).map((d) => d.detail).join("; ")}`,
        fingerprint
      };
    }
  }
  return {
    type: p.type,
    passed: false,
    expected: "valid infrastructure predicate",
    actual: `unrecognized predicate config: type=${p.type}, resource=${p.resource}, assertion=${p.assertion}`,
    fingerprint
  };
}
function infraPredicateFingerprint(p) {
  const parts = [`type=${p.type}`];
  if (p.resource) parts.push(`resource=${p.resource}`);
  if (p.attribute) parts.push(`attribute=${p.attribute}`);
  if (p.expected) parts.push(`exp=${p.expected}`);
  if (p.assertion) parts.push(`assertion=${p.assertion}`);
  if (p.stateFile) parts.push(`stateFile=${p.stateFile}`);
  return parts.join("|");
}
function describeExpected(p) {
  if (p.type === "infra_resource") return `${p.resource} ${p.assertion ?? "exists"}`;
  if (p.type === "infra_attribute") return `${p.resource}.${p.attribute} == ${p.expected}`;
  if (p.type === "infra_manifest") return `state ${p.assertion ?? "matches_manifest"}`;
  return "infrastructure check";
}
function findInfraDir(appDir) {
  if ((0, import_fs3.existsSync)((0, import_path3.join)(appDir, "terraform.tfstate"))) return appDir;
  const subdirs = ["infra", "terraform", "infrastructure", "iac"];
  for (const sub of subdirs) {
    const dir = (0, import_path3.join)(appDir, sub);
    if ((0, import_fs3.existsSync)((0, import_path3.join)(dir, "terraform.tfstate"))) return dir;
    if ((0, import_fs3.existsSync)((0, import_path3.join)(dir, "manifest.json"))) return dir;
  }
  const sibling = (0, import_path3.join)(appDir, "..", "demo-infra");
  if ((0, import_fs3.existsSync)((0, import_path3.join)(sibling, "terraform.tfstate"))) return sibling;
  return void 0;
}
var import_fs3, import_path3;
var init_infrastructure = __esm({
  "src/gates/infrastructure.ts"() {
    "use strict";
    import_fs3 = require("fs");
    import_path3 = require("path");
  }
});

// node_modules/@pgsql/types/types.js
var require_types = __commonJS({
  "node_modules/@pgsql/types/types.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
  }
});

// node_modules/@pgsql/types/enums.js
var require_enums = __commonJS({
  "node_modules/@pgsql/types/enums.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
  }
});

// node_modules/@pgsql/types/index.js
var require_types2 = __commonJS({
  "node_modules/@pgsql/types/index.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __exportStar = exports2 && exports2.__exportStar || function(m, exports3) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports3, p)) __createBinding(exports3, m, p);
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    __exportStar(require_types(), exports2);
    __exportStar(require_enums(), exports2);
  }
});

// node_modules/libpg-query/wasm/libpg-query.js
var require_libpg_query = __commonJS({
  "node_modules/libpg-query/wasm/libpg-query.js"(exports2, module2) {
    var PgQueryModule = (() => {
      var _scriptName = typeof document != "undefined" ? document.currentScript?.src : void 0;
      return (async function(moduleArg = {}) {
        var moduleRtn;
        var Module = moduleArg;
        var ENVIRONMENT_IS_WEB = typeof window == "object";
        var ENVIRONMENT_IS_WORKER = typeof WorkerGlobalScope != "undefined";
        var ENVIRONMENT_IS_NODE = typeof process == "object" && process.versions?.node && process.type != "renderer";
        var arguments_ = [];
        var thisProgram = "./this.program";
        var quit_ = (status, toThrow) => {
          throw toThrow;
        };
        if (typeof __filename != "undefined") {
          _scriptName = __filename;
        } else if (ENVIRONMENT_IS_WORKER) {
          _scriptName = self.location.href;
        }
        var scriptDirectory = "";
        function locateFile(path) {
          if (Module["locateFile"]) {
            return Module["locateFile"](path, scriptDirectory);
          }
          return scriptDirectory + path;
        }
        var readAsync, readBinary;
        if (ENVIRONMENT_IS_NODE) {
          var fs = require("fs");
          scriptDirectory = __dirname + "/";
          readBinary = (filename) => {
            filename = isFileURI(filename) ? new URL(filename) : filename;
            var ret = fs.readFileSync(filename);
            return ret;
          };
          readAsync = async (filename, binary = true) => {
            filename = isFileURI(filename) ? new URL(filename) : filename;
            var ret = fs.readFileSync(filename, binary ? void 0 : "utf8");
            return ret;
          };
          if (process.argv.length > 1) {
            thisProgram = process.argv[1].replace(/\\/g, "/");
          }
          arguments_ = process.argv.slice(2);
          quit_ = (status, toThrow) => {
            process.exitCode = status;
            throw toThrow;
          };
        } else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
          try {
            scriptDirectory = new URL(".", _scriptName).href;
          } catch {
          }
          {
            if (ENVIRONMENT_IS_WORKER) {
              readBinary = (url) => {
                var xhr = new XMLHttpRequest();
                xhr.open("GET", url, false);
                xhr.responseType = "arraybuffer";
                xhr.send(null);
                return new Uint8Array(xhr.response);
              };
            }
            readAsync = async (url) => {
              var response = await fetch(url, { credentials: "same-origin" });
              if (response.ok) {
                return response.arrayBuffer();
              }
              throw new Error(response.status + " : " + response.url);
            };
          }
        } else {
        }
        var out = console.log.bind(console);
        var err = console.error.bind(console);
        var wasmBinary;
        var ABORT = false;
        var EXITSTATUS;
        var isFileURI = (filename) => filename.startsWith("file://");
        var readyPromiseResolve, readyPromiseReject;
        var wasmMemory;
        var HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAPF64;
        var HEAP64, HEAPU64;
        var runtimeInitialized = false;
        function updateMemoryViews() {
          var b = wasmMemory.buffer;
          HEAP8 = new Int8Array(b);
          HEAP16 = new Int16Array(b);
          Module["HEAPU8"] = HEAPU8 = new Uint8Array(b);
          HEAPU16 = new Uint16Array(b);
          HEAP32 = new Int32Array(b);
          Module["HEAPU32"] = HEAPU32 = new Uint32Array(b);
          HEAPF32 = new Float32Array(b);
          HEAPF64 = new Float64Array(b);
          HEAP64 = new BigInt64Array(b);
          HEAPU64 = new BigUint64Array(b);
        }
        function preRun() {
          if (Module["preRun"]) {
            if (typeof Module["preRun"] == "function") Module["preRun"] = [Module["preRun"]];
            while (Module["preRun"].length) {
              addOnPreRun(Module["preRun"].shift());
            }
          }
          callRuntimeCallbacks(onPreRuns);
        }
        function initRuntime() {
          runtimeInitialized = true;
          if (!Module["noFSInit"] && !FS.initialized) FS.init();
          TTY.init();
          wasmExports["q"]();
          FS.ignorePermissions = false;
        }
        function postRun() {
          if (Module["postRun"]) {
            if (typeof Module["postRun"] == "function") Module["postRun"] = [Module["postRun"]];
            while (Module["postRun"].length) {
              addOnPostRun(Module["postRun"].shift());
            }
          }
          callRuntimeCallbacks(onPostRuns);
        }
        var runDependencies = 0;
        var dependenciesFulfilled = null;
        function addRunDependency(id) {
          runDependencies++;
          Module["monitorRunDependencies"]?.(runDependencies);
        }
        function removeRunDependency(id) {
          runDependencies--;
          Module["monitorRunDependencies"]?.(runDependencies);
          if (runDependencies == 0) {
            if (dependenciesFulfilled) {
              var callback = dependenciesFulfilled;
              dependenciesFulfilled = null;
              callback();
            }
          }
        }
        function abort(what) {
          Module["onAbort"]?.(what);
          what = "Aborted(" + what + ")";
          err(what);
          ABORT = true;
          what += ". Build with -sASSERTIONS for more info.";
          var e = new WebAssembly.RuntimeError(what);
          readyPromiseReject?.(e);
          throw e;
        }
        var wasmBinaryFile;
        function findWasmBinary() {
          return locateFile("libpg-query.wasm");
        }
        function getBinarySync(file) {
          if (file == wasmBinaryFile && wasmBinary) {
            return new Uint8Array(wasmBinary);
          }
          if (readBinary) {
            return readBinary(file);
          }
          throw "both async and sync fetching of the wasm failed";
        }
        async function getWasmBinary(binaryFile) {
          if (!wasmBinary) {
            try {
              var response = await readAsync(binaryFile);
              return new Uint8Array(response);
            } catch {
            }
          }
          return getBinarySync(binaryFile);
        }
        async function instantiateArrayBuffer(binaryFile, imports) {
          try {
            var binary = await getWasmBinary(binaryFile);
            var instance = await WebAssembly.instantiate(binary, imports);
            return instance;
          } catch (reason) {
            err(`failed to asynchronously prepare wasm: ${reason}`);
            abort(reason);
          }
        }
        async function instantiateAsync(binary, binaryFile, imports) {
          if (!binary && typeof WebAssembly.instantiateStreaming == "function" && !ENVIRONMENT_IS_NODE) {
            try {
              var response = fetch(binaryFile, { credentials: "same-origin" });
              var instantiationResult = await WebAssembly.instantiateStreaming(response, imports);
              return instantiationResult;
            } catch (reason) {
              err(`wasm streaming compile failed: ${reason}`);
              err("falling back to ArrayBuffer instantiation");
            }
          }
          return instantiateArrayBuffer(binaryFile, imports);
        }
        function getWasmImports() {
          return { a: wasmImports };
        }
        async function createWasm() {
          function receiveInstance(instance, module3) {
            wasmExports = instance.exports;
            wasmMemory = wasmExports["p"];
            updateMemoryViews();
            wasmTable = wasmExports["t"];
            assignWasmExports(wasmExports);
            removeRunDependency("wasm-instantiate");
            return wasmExports;
          }
          addRunDependency("wasm-instantiate");
          function receiveInstantiationResult(result2) {
            return receiveInstance(result2["instance"]);
          }
          var info = getWasmImports();
          if (Module["instantiateWasm"]) {
            return new Promise((resolve2, reject) => {
              Module["instantiateWasm"](info, (mod, inst) => {
                resolve2(receiveInstance(mod, inst));
              });
            });
          }
          wasmBinaryFile ??= findWasmBinary();
          var result = await instantiateAsync(wasmBinary, wasmBinaryFile, info);
          var exports3 = receiveInstantiationResult(result);
          return exports3;
        }
        class ExitStatus {
          name = "ExitStatus";
          constructor(status) {
            this.message = `Program terminated with exit(${status})`;
            this.status = status;
          }
        }
        var callRuntimeCallbacks = (callbacks) => {
          while (callbacks.length > 0) {
            callbacks.shift()(Module);
          }
        };
        var onPostRuns = [];
        var addOnPostRun = (cb) => onPostRuns.push(cb);
        var onPreRuns = [];
        var addOnPreRun = (cb) => onPreRuns.push(cb);
        function getValue(ptr, type = "i8") {
          if (type.endsWith("*")) type = "*";
          switch (type) {
            case "i1":
              return HEAP8[ptr];
            case "i8":
              return HEAP8[ptr];
            case "i16":
              return HEAP16[ptr >> 1];
            case "i32":
              return HEAP32[ptr >> 2];
            case "i64":
              return HEAP64[ptr >> 3];
            case "float":
              return HEAPF32[ptr >> 2];
            case "double":
              return HEAPF64[ptr >> 3];
            case "*":
              return HEAPU32[ptr >> 2];
            default:
              abort(`invalid type for getValue: ${type}`);
          }
        }
        var noExitRuntime = true;
        var stackRestore = (val) => __emscripten_stack_restore(val);
        var stackSave = () => _emscripten_stack_get_current();
        var __abort_js = () => abort("");
        var runtimeKeepaliveCounter = 0;
        var __emscripten_runtime_keepalive_clear = () => {
          noExitRuntime = false;
          runtimeKeepaliveCounter = 0;
        };
        var __emscripten_throw_longjmp = () => {
          throw Infinity;
        };
        var timers = {};
        var handleException = (e) => {
          if (e instanceof ExitStatus || e == "unwind") {
            return EXITSTATUS;
          }
          quit_(1, e);
        };
        var keepRuntimeAlive = () => noExitRuntime || runtimeKeepaliveCounter > 0;
        var _proc_exit = (code) => {
          EXITSTATUS = code;
          if (!keepRuntimeAlive()) {
            Module["onExit"]?.(code);
            ABORT = true;
          }
          quit_(code, new ExitStatus(code));
        };
        var exitJS = (status, implicit) => {
          EXITSTATUS = status;
          _proc_exit(status);
        };
        var _exit = exitJS;
        var maybeExit = () => {
          if (!keepRuntimeAlive()) {
            try {
              _exit(EXITSTATUS);
            } catch (e) {
              handleException(e);
            }
          }
        };
        var callUserCallback = (func) => {
          if (ABORT) {
            return;
          }
          try {
            func();
            maybeExit();
          } catch (e) {
            handleException(e);
          }
        };
        var _emscripten_get_now = () => performance.now();
        var __setitimer_js = (which, timeout_ms) => {
          if (timers[which]) {
            clearTimeout(timers[which].id);
            delete timers[which];
          }
          if (!timeout_ms) return 0;
          var id = setTimeout(() => {
            delete timers[which];
            callUserCallback(() => __emscripten_timeout(which, _emscripten_get_now()));
          }, timeout_ms);
          timers[which] = { id, timeout_ms };
          return 0;
        };
        var getHeapMax = () => 1073741824;
        var alignMemory = (size, alignment) => Math.ceil(size / alignment) * alignment;
        var growMemory = (size) => {
          var b = wasmMemory.buffer;
          var pages = (size - b.byteLength + 65535) / 65536 | 0;
          try {
            wasmMemory.grow(pages);
            updateMemoryViews();
            return 1;
          } catch (e) {
          }
        };
        var _emscripten_resize_heap = (requestedSize) => {
          var oldSize = HEAPU8.length;
          requestedSize >>>= 0;
          var maxHeapSize = getHeapMax();
          if (requestedSize > maxHeapSize) {
            return false;
          }
          for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
            var overGrownHeapSize = oldSize * (1 + 0.2 / cutDown);
            overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
            var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
            var replacement = growMemory(newSize);
            if (replacement) {
              return true;
            }
          }
          return false;
        };
        var PATH = { isAbs: (path) => path.charAt(0) === "/", splitPath: (filename) => {
          var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
          return splitPathRe.exec(filename).slice(1);
        }, normalizeArray: (parts, allowAboveRoot) => {
          var up = 0;
          for (var i = parts.length - 1; i >= 0; i--) {
            var last = parts[i];
            if (last === ".") {
              parts.splice(i, 1);
            } else if (last === "..") {
              parts.splice(i, 1);
              up++;
            } else if (up) {
              parts.splice(i, 1);
              up--;
            }
          }
          if (allowAboveRoot) {
            for (; up; up--) {
              parts.unshift("..");
            }
          }
          return parts;
        }, normalize: (path) => {
          var isAbsolute2 = PATH.isAbs(path), trailingSlash = path.slice(-1) === "/";
          path = PATH.normalizeArray(path.split("/").filter((p) => !!p), !isAbsolute2).join("/");
          if (!path && !isAbsolute2) {
            path = ".";
          }
          if (path && trailingSlash) {
            path += "/";
          }
          return (isAbsolute2 ? "/" : "") + path;
        }, dirname: (path) => {
          var result = PATH.splitPath(path), root = result[0], dir = result[1];
          if (!root && !dir) {
            return ".";
          }
          if (dir) {
            dir = dir.slice(0, -1);
          }
          return root + dir;
        }, basename: (path) => path && path.match(/([^\/]+|\/)\/*$/)[1], join: (...paths) => PATH.normalize(paths.join("/")), join2: (l, r) => PATH.normalize(l + "/" + r) };
        var initRandomFill = () => {
          if (ENVIRONMENT_IS_NODE) {
            var nodeCrypto = require("crypto");
            return (view) => nodeCrypto.randomFillSync(view);
          }
          return (view) => crypto.getRandomValues(view);
        };
        var randomFill = (view) => {
          (randomFill = initRandomFill())(view);
        };
        var PATH_FS = { resolve: (...args) => {
          var resolvedPath = "", resolvedAbsolute = false;
          for (var i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
            var path = i >= 0 ? args[i] : FS.cwd();
            if (typeof path != "string") {
              throw new TypeError("Arguments to path.resolve must be strings");
            } else if (!path) {
              return "";
            }
            resolvedPath = path + "/" + resolvedPath;
            resolvedAbsolute = PATH.isAbs(path);
          }
          resolvedPath = PATH.normalizeArray(resolvedPath.split("/").filter((p) => !!p), !resolvedAbsolute).join("/");
          return (resolvedAbsolute ? "/" : "") + resolvedPath || ".";
        }, relative: (from, to) => {
          from = PATH_FS.resolve(from).slice(1);
          to = PATH_FS.resolve(to).slice(1);
          function trim(arr) {
            var start = 0;
            for (; start < arr.length; start++) {
              if (arr[start] !== "") break;
            }
            var end = arr.length - 1;
            for (; end >= 0; end--) {
              if (arr[end] !== "") break;
            }
            if (start > end) return [];
            return arr.slice(start, end - start + 1);
          }
          var fromParts = trim(from.split("/"));
          var toParts = trim(to.split("/"));
          var length = Math.min(fromParts.length, toParts.length);
          var samePartsLength = length;
          for (var i = 0; i < length; i++) {
            if (fromParts[i] !== toParts[i]) {
              samePartsLength = i;
              break;
            }
          }
          var outputParts = [];
          for (var i = samePartsLength; i < fromParts.length; i++) {
            outputParts.push("..");
          }
          outputParts = outputParts.concat(toParts.slice(samePartsLength));
          return outputParts.join("/");
        } };
        var UTF8Decoder = typeof TextDecoder != "undefined" ? new TextDecoder() : void 0;
        var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead = NaN) => {
          var endIdx = idx + maxBytesToRead;
          var endPtr = idx;
          while (heapOrArray[endPtr] && !(endPtr >= endIdx)) ++endPtr;
          if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
            return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
          }
          var str = "";
          while (idx < endPtr) {
            var u0 = heapOrArray[idx++];
            if (!(u0 & 128)) {
              str += String.fromCharCode(u0);
              continue;
            }
            var u1 = heapOrArray[idx++] & 63;
            if ((u0 & 224) == 192) {
              str += String.fromCharCode((u0 & 31) << 6 | u1);
              continue;
            }
            var u2 = heapOrArray[idx++] & 63;
            if ((u0 & 240) == 224) {
              u0 = (u0 & 15) << 12 | u1 << 6 | u2;
            } else {
              u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | heapOrArray[idx++] & 63;
            }
            if (u0 < 65536) {
              str += String.fromCharCode(u0);
            } else {
              var ch = u0 - 65536;
              str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023);
            }
          }
          return str;
        };
        var FS_stdin_getChar_buffer = [];
        var lengthBytesUTF8 = (str) => {
          var len = 0;
          for (var i = 0; i < str.length; ++i) {
            var c = str.charCodeAt(i);
            if (c <= 127) {
              len++;
            } else if (c <= 2047) {
              len += 2;
            } else if (c >= 55296 && c <= 57343) {
              len += 4;
              ++i;
            } else {
              len += 3;
            }
          }
          return len;
        };
        var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => {
          if (!(maxBytesToWrite > 0)) return 0;
          var startIdx = outIdx;
          var endIdx = outIdx + maxBytesToWrite - 1;
          for (var i = 0; i < str.length; ++i) {
            var u = str.codePointAt(i);
            if (u <= 127) {
              if (outIdx >= endIdx) break;
              heap[outIdx++] = u;
            } else if (u <= 2047) {
              if (outIdx + 1 >= endIdx) break;
              heap[outIdx++] = 192 | u >> 6;
              heap[outIdx++] = 128 | u & 63;
            } else if (u <= 65535) {
              if (outIdx + 2 >= endIdx) break;
              heap[outIdx++] = 224 | u >> 12;
              heap[outIdx++] = 128 | u >> 6 & 63;
              heap[outIdx++] = 128 | u & 63;
            } else {
              if (outIdx + 3 >= endIdx) break;
              heap[outIdx++] = 240 | u >> 18;
              heap[outIdx++] = 128 | u >> 12 & 63;
              heap[outIdx++] = 128 | u >> 6 & 63;
              heap[outIdx++] = 128 | u & 63;
              i++;
            }
          }
          heap[outIdx] = 0;
          return outIdx - startIdx;
        };
        var intArrayFromString = (stringy, dontAddNull, length) => {
          var len = length > 0 ? length : lengthBytesUTF8(stringy) + 1;
          var u8array = new Array(len);
          var numBytesWritten = stringToUTF8Array(stringy, u8array, 0, u8array.length);
          if (dontAddNull) u8array.length = numBytesWritten;
          return u8array;
        };
        var FS_stdin_getChar = () => {
          if (!FS_stdin_getChar_buffer.length) {
            var result = null;
            if (ENVIRONMENT_IS_NODE) {
              var BUFSIZE = 256;
              var buf = Buffer.alloc(BUFSIZE);
              var bytesRead = 0;
              var fd = process.stdin.fd;
              try {
                bytesRead = fs.readSync(fd, buf, 0, BUFSIZE);
              } catch (e) {
                if (e.toString().includes("EOF")) bytesRead = 0;
                else throw e;
              }
              if (bytesRead > 0) {
                result = buf.slice(0, bytesRead).toString("utf-8");
              }
            } else if (typeof window != "undefined" && typeof window.prompt == "function") {
              result = window.prompt("Input: ");
              if (result !== null) {
                result += "\n";
              }
            } else {
            }
            if (!result) {
              return null;
            }
            FS_stdin_getChar_buffer = intArrayFromString(result, true);
          }
          return FS_stdin_getChar_buffer.shift();
        };
        var TTY = { ttys: [], init() {
        }, shutdown() {
        }, register(dev, ops) {
          TTY.ttys[dev] = { input: [], output: [], ops };
          FS.registerDevice(dev, TTY.stream_ops);
        }, stream_ops: { open(stream) {
          var tty = TTY.ttys[stream.node.rdev];
          if (!tty) {
            throw new FS.ErrnoError(43);
          }
          stream.tty = tty;
          stream.seekable = false;
        }, close(stream) {
          stream.tty.ops.fsync(stream.tty);
        }, fsync(stream) {
          stream.tty.ops.fsync(stream.tty);
        }, read(stream, buffer, offset, length, pos) {
          if (!stream.tty || !stream.tty.ops.get_char) {
            throw new FS.ErrnoError(60);
          }
          var bytesRead = 0;
          for (var i = 0; i < length; i++) {
            var result;
            try {
              result = stream.tty.ops.get_char(stream.tty);
            } catch (e) {
              throw new FS.ErrnoError(29);
            }
            if (result === void 0 && bytesRead === 0) {
              throw new FS.ErrnoError(6);
            }
            if (result === null || result === void 0) break;
            bytesRead++;
            buffer[offset + i] = result;
          }
          if (bytesRead) {
            stream.node.atime = Date.now();
          }
          return bytesRead;
        }, write(stream, buffer, offset, length, pos) {
          if (!stream.tty || !stream.tty.ops.put_char) {
            throw new FS.ErrnoError(60);
          }
          try {
            for (var i = 0; i < length; i++) {
              stream.tty.ops.put_char(stream.tty, buffer[offset + i]);
            }
          } catch (e) {
            throw new FS.ErrnoError(29);
          }
          if (length) {
            stream.node.mtime = stream.node.ctime = Date.now();
          }
          return i;
        } }, default_tty_ops: { get_char(tty) {
          return FS_stdin_getChar();
        }, put_char(tty, val) {
          if (val === null || val === 10) {
            out(UTF8ArrayToString(tty.output));
            tty.output = [];
          } else {
            if (val != 0) tty.output.push(val);
          }
        }, fsync(tty) {
          if (tty.output?.length > 0) {
            out(UTF8ArrayToString(tty.output));
            tty.output = [];
          }
        }, ioctl_tcgets(tty) {
          return { c_iflag: 25856, c_oflag: 5, c_cflag: 191, c_lflag: 35387, c_cc: [3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
        }, ioctl_tcsets(tty, optional_actions, data) {
          return 0;
        }, ioctl_tiocgwinsz(tty) {
          return [24, 80];
        } }, default_tty1_ops: { put_char(tty, val) {
          if (val === null || val === 10) {
            err(UTF8ArrayToString(tty.output));
            tty.output = [];
          } else {
            if (val != 0) tty.output.push(val);
          }
        }, fsync(tty) {
          if (tty.output?.length > 0) {
            err(UTF8ArrayToString(tty.output));
            tty.output = [];
          }
        } } };
        var mmapAlloc = (size) => {
          abort();
        };
        var MEMFS = { ops_table: null, mount(mount) {
          return MEMFS.createNode(null, "/", 16895, 0);
        }, createNode(parent, name, mode, dev) {
          if (FS.isBlkdev(mode) || FS.isFIFO(mode)) {
            throw new FS.ErrnoError(63);
          }
          MEMFS.ops_table ||= { dir: { node: { getattr: MEMFS.node_ops.getattr, setattr: MEMFS.node_ops.setattr, lookup: MEMFS.node_ops.lookup, mknod: MEMFS.node_ops.mknod, rename: MEMFS.node_ops.rename, unlink: MEMFS.node_ops.unlink, rmdir: MEMFS.node_ops.rmdir, readdir: MEMFS.node_ops.readdir, symlink: MEMFS.node_ops.symlink }, stream: { llseek: MEMFS.stream_ops.llseek } }, file: { node: { getattr: MEMFS.node_ops.getattr, setattr: MEMFS.node_ops.setattr }, stream: { llseek: MEMFS.stream_ops.llseek, read: MEMFS.stream_ops.read, write: MEMFS.stream_ops.write, mmap: MEMFS.stream_ops.mmap, msync: MEMFS.stream_ops.msync } }, link: { node: { getattr: MEMFS.node_ops.getattr, setattr: MEMFS.node_ops.setattr, readlink: MEMFS.node_ops.readlink }, stream: {} }, chrdev: { node: { getattr: MEMFS.node_ops.getattr, setattr: MEMFS.node_ops.setattr }, stream: FS.chrdev_stream_ops } };
          var node = FS.createNode(parent, name, mode, dev);
          if (FS.isDir(node.mode)) {
            node.node_ops = MEMFS.ops_table.dir.node;
            node.stream_ops = MEMFS.ops_table.dir.stream;
            node.contents = {};
          } else if (FS.isFile(node.mode)) {
            node.node_ops = MEMFS.ops_table.file.node;
            node.stream_ops = MEMFS.ops_table.file.stream;
            node.usedBytes = 0;
            node.contents = null;
          } else if (FS.isLink(node.mode)) {
            node.node_ops = MEMFS.ops_table.link.node;
            node.stream_ops = MEMFS.ops_table.link.stream;
          } else if (FS.isChrdev(node.mode)) {
            node.node_ops = MEMFS.ops_table.chrdev.node;
            node.stream_ops = MEMFS.ops_table.chrdev.stream;
          }
          node.atime = node.mtime = node.ctime = Date.now();
          if (parent) {
            parent.contents[name] = node;
            parent.atime = parent.mtime = parent.ctime = node.atime;
          }
          return node;
        }, getFileDataAsTypedArray(node) {
          if (!node.contents) return new Uint8Array(0);
          if (node.contents.subarray) return node.contents.subarray(0, node.usedBytes);
          return new Uint8Array(node.contents);
        }, expandFileStorage(node, newCapacity) {
          var prevCapacity = node.contents ? node.contents.length : 0;
          if (prevCapacity >= newCapacity) return;
          var CAPACITY_DOUBLING_MAX = 1024 * 1024;
          newCapacity = Math.max(newCapacity, prevCapacity * (prevCapacity < CAPACITY_DOUBLING_MAX ? 2 : 1.125) >>> 0);
          if (prevCapacity != 0) newCapacity = Math.max(newCapacity, 256);
          var oldContents = node.contents;
          node.contents = new Uint8Array(newCapacity);
          if (node.usedBytes > 0) node.contents.set(oldContents.subarray(0, node.usedBytes), 0);
        }, resizeFileStorage(node, newSize) {
          if (node.usedBytes == newSize) return;
          if (newSize == 0) {
            node.contents = null;
            node.usedBytes = 0;
          } else {
            var oldContents = node.contents;
            node.contents = new Uint8Array(newSize);
            if (oldContents) {
              node.contents.set(oldContents.subarray(0, Math.min(newSize, node.usedBytes)));
            }
            node.usedBytes = newSize;
          }
        }, node_ops: { getattr(node) {
          var attr = {};
          attr.dev = FS.isChrdev(node.mode) ? node.id : 1;
          attr.ino = node.id;
          attr.mode = node.mode;
          attr.nlink = 1;
          attr.uid = 0;
          attr.gid = 0;
          attr.rdev = node.rdev;
          if (FS.isDir(node.mode)) {
            attr.size = 4096;
          } else if (FS.isFile(node.mode)) {
            attr.size = node.usedBytes;
          } else if (FS.isLink(node.mode)) {
            attr.size = node.link.length;
          } else {
            attr.size = 0;
          }
          attr.atime = new Date(node.atime);
          attr.mtime = new Date(node.mtime);
          attr.ctime = new Date(node.ctime);
          attr.blksize = 4096;
          attr.blocks = Math.ceil(attr.size / attr.blksize);
          return attr;
        }, setattr(node, attr) {
          for (const key of ["mode", "atime", "mtime", "ctime"]) {
            if (attr[key] != null) {
              node[key] = attr[key];
            }
          }
          if (attr.size !== void 0) {
            MEMFS.resizeFileStorage(node, attr.size);
          }
        }, lookup(parent, name) {
          throw MEMFS.doesNotExistError;
        }, mknod(parent, name, mode, dev) {
          return MEMFS.createNode(parent, name, mode, dev);
        }, rename(old_node, new_dir, new_name) {
          var new_node;
          try {
            new_node = FS.lookupNode(new_dir, new_name);
          } catch (e) {
          }
          if (new_node) {
            if (FS.isDir(old_node.mode)) {
              for (var i in new_node.contents) {
                throw new FS.ErrnoError(55);
              }
            }
            FS.hashRemoveNode(new_node);
          }
          delete old_node.parent.contents[old_node.name];
          new_dir.contents[new_name] = old_node;
          old_node.name = new_name;
          new_dir.ctime = new_dir.mtime = old_node.parent.ctime = old_node.parent.mtime = Date.now();
        }, unlink(parent, name) {
          delete parent.contents[name];
          parent.ctime = parent.mtime = Date.now();
        }, rmdir(parent, name) {
          var node = FS.lookupNode(parent, name);
          for (var i in node.contents) {
            throw new FS.ErrnoError(55);
          }
          delete parent.contents[name];
          parent.ctime = parent.mtime = Date.now();
        }, readdir(node) {
          return [".", "..", ...Object.keys(node.contents)];
        }, symlink(parent, newname, oldpath) {
          var node = MEMFS.createNode(parent, newname, 511 | 40960, 0);
          node.link = oldpath;
          return node;
        }, readlink(node) {
          if (!FS.isLink(node.mode)) {
            throw new FS.ErrnoError(28);
          }
          return node.link;
        } }, stream_ops: { read(stream, buffer, offset, length, position) {
          var contents = stream.node.contents;
          if (position >= stream.node.usedBytes) return 0;
          var size = Math.min(stream.node.usedBytes - position, length);
          if (size > 8 && contents.subarray) {
            buffer.set(contents.subarray(position, position + size), offset);
          } else {
            for (var i = 0; i < size; i++) buffer[offset + i] = contents[position + i];
          }
          return size;
        }, write(stream, buffer, offset, length, position, canOwn) {
          if (buffer.buffer === HEAP8.buffer) {
            canOwn = false;
          }
          if (!length) return 0;
          var node = stream.node;
          node.mtime = node.ctime = Date.now();
          if (buffer.subarray && (!node.contents || node.contents.subarray)) {
            if (canOwn) {
              node.contents = buffer.subarray(offset, offset + length);
              node.usedBytes = length;
              return length;
            } else if (node.usedBytes === 0 && position === 0) {
              node.contents = buffer.slice(offset, offset + length);
              node.usedBytes = length;
              return length;
            } else if (position + length <= node.usedBytes) {
              node.contents.set(buffer.subarray(offset, offset + length), position);
              return length;
            }
          }
          MEMFS.expandFileStorage(node, position + length);
          if (node.contents.subarray && buffer.subarray) {
            node.contents.set(buffer.subarray(offset, offset + length), position);
          } else {
            for (var i = 0; i < length; i++) {
              node.contents[position + i] = buffer[offset + i];
            }
          }
          node.usedBytes = Math.max(node.usedBytes, position + length);
          return length;
        }, llseek(stream, offset, whence) {
          var position = offset;
          if (whence === 1) {
            position += stream.position;
          } else if (whence === 2) {
            if (FS.isFile(stream.node.mode)) {
              position += stream.node.usedBytes;
            }
          }
          if (position < 0) {
            throw new FS.ErrnoError(28);
          }
          return position;
        }, mmap(stream, length, position, prot, flags) {
          if (!FS.isFile(stream.node.mode)) {
            throw new FS.ErrnoError(43);
          }
          var ptr;
          var allocated;
          var contents = stream.node.contents;
          if (!(flags & 2) && contents && contents.buffer === HEAP8.buffer) {
            allocated = false;
            ptr = contents.byteOffset;
          } else {
            allocated = true;
            ptr = mmapAlloc(length);
            if (!ptr) {
              throw new FS.ErrnoError(48);
            }
            if (contents) {
              if (position > 0 || position + length < contents.length) {
                if (contents.subarray) {
                  contents = contents.subarray(position, position + length);
                } else {
                  contents = Array.prototype.slice.call(contents, position, position + length);
                }
              }
              HEAP8.set(contents, ptr);
            }
          }
          return { ptr, allocated };
        }, msync(stream, buffer, offset, length, mmapFlags) {
          MEMFS.stream_ops.write(stream, buffer, 0, length, offset, false);
          return 0;
        } } };
        var asyncLoad = async (url) => {
          var arrayBuffer = await readAsync(url);
          return new Uint8Array(arrayBuffer);
        };
        var FS_createDataFile = (...args) => FS.createDataFile(...args);
        var getUniqueRunDependency = (id) => id;
        var preloadPlugins = [];
        var FS_handledByPreloadPlugin = (byteArray, fullname, finish, onerror) => {
          if (typeof Browser != "undefined") Browser.init();
          var handled = false;
          preloadPlugins.forEach((plugin) => {
            if (handled) return;
            if (plugin["canHandle"](fullname)) {
              plugin["handle"](byteArray, fullname, finish, onerror);
              handled = true;
            }
          });
          return handled;
        };
        var FS_createPreloadedFile = (parent, name, url, canRead, canWrite, onload, onerror, dontCreateFile, canOwn, preFinish) => {
          var fullname = name ? PATH_FS.resolve(PATH.join2(parent, name)) : parent;
          var dep = getUniqueRunDependency(`cp ${fullname}`);
          function processData(byteArray) {
            function finish(byteArray2) {
              preFinish?.();
              if (!dontCreateFile) {
                FS_createDataFile(parent, name, byteArray2, canRead, canWrite, canOwn);
              }
              onload?.();
              removeRunDependency(dep);
            }
            if (FS_handledByPreloadPlugin(byteArray, fullname, finish, () => {
              onerror?.();
              removeRunDependency(dep);
            })) {
              return;
            }
            finish(byteArray);
          }
          addRunDependency(dep);
          if (typeof url == "string") {
            asyncLoad(url).then(processData, onerror);
          } else {
            processData(url);
          }
        };
        var FS_modeStringToFlags = (str) => {
          var flagModes = { r: 0, "r+": 2, w: 512 | 64 | 1, "w+": 512 | 64 | 2, a: 1024 | 64 | 1, "a+": 1024 | 64 | 2 };
          var flags = flagModes[str];
          if (typeof flags == "undefined") {
            throw new Error(`Unknown file open mode: ${str}`);
          }
          return flags;
        };
        var FS_getMode = (canRead, canWrite) => {
          var mode = 0;
          if (canRead) mode |= 292 | 73;
          if (canWrite) mode |= 146;
          return mode;
        };
        var FS = { root: null, mounts: [], devices: {}, streams: [], nextInode: 1, nameTable: null, currentPath: "/", initialized: false, ignorePermissions: true, filesystems: null, syncFSRequests: 0, readFiles: {}, ErrnoError: class {
          name = "ErrnoError";
          constructor(errno) {
            this.errno = errno;
          }
        }, FSStream: class {
          shared = {};
          get object() {
            return this.node;
          }
          set object(val) {
            this.node = val;
          }
          get isRead() {
            return (this.flags & 2097155) !== 1;
          }
          get isWrite() {
            return (this.flags & 2097155) !== 0;
          }
          get isAppend() {
            return this.flags & 1024;
          }
          get flags() {
            return this.shared.flags;
          }
          set flags(val) {
            this.shared.flags = val;
          }
          get position() {
            return this.shared.position;
          }
          set position(val) {
            this.shared.position = val;
          }
        }, FSNode: class {
          node_ops = {};
          stream_ops = {};
          readMode = 292 | 73;
          writeMode = 146;
          mounted = null;
          constructor(parent, name, mode, rdev) {
            if (!parent) {
              parent = this;
            }
            this.parent = parent;
            this.mount = parent.mount;
            this.id = FS.nextInode++;
            this.name = name;
            this.mode = mode;
            this.rdev = rdev;
            this.atime = this.mtime = this.ctime = Date.now();
          }
          get read() {
            return (this.mode & this.readMode) === this.readMode;
          }
          set read(val) {
            val ? this.mode |= this.readMode : this.mode &= ~this.readMode;
          }
          get write() {
            return (this.mode & this.writeMode) === this.writeMode;
          }
          set write(val) {
            val ? this.mode |= this.writeMode : this.mode &= ~this.writeMode;
          }
          get isFolder() {
            return FS.isDir(this.mode);
          }
          get isDevice() {
            return FS.isChrdev(this.mode);
          }
        }, lookupPath(path, opts = {}) {
          if (!path) {
            throw new FS.ErrnoError(44);
          }
          opts.follow_mount ??= true;
          if (!PATH.isAbs(path)) {
            path = FS.cwd() + "/" + path;
          }
          linkloop: for (var nlinks = 0; nlinks < 40; nlinks++) {
            var parts = path.split("/").filter((p) => !!p);
            var current = FS.root;
            var current_path = "/";
            for (var i = 0; i < parts.length; i++) {
              var islast = i === parts.length - 1;
              if (islast && opts.parent) {
                break;
              }
              if (parts[i] === ".") {
                continue;
              }
              if (parts[i] === "..") {
                current_path = PATH.dirname(current_path);
                if (FS.isRoot(current)) {
                  path = current_path + "/" + parts.slice(i + 1).join("/");
                  continue linkloop;
                } else {
                  current = current.parent;
                }
                continue;
              }
              current_path = PATH.join2(current_path, parts[i]);
              try {
                current = FS.lookupNode(current, parts[i]);
              } catch (e) {
                if (e?.errno === 44 && islast && opts.noent_okay) {
                  return { path: current_path };
                }
                throw e;
              }
              if (FS.isMountpoint(current) && (!islast || opts.follow_mount)) {
                current = current.mounted.root;
              }
              if (FS.isLink(current.mode) && (!islast || opts.follow)) {
                if (!current.node_ops.readlink) {
                  throw new FS.ErrnoError(52);
                }
                var link = current.node_ops.readlink(current);
                if (!PATH.isAbs(link)) {
                  link = PATH.dirname(current_path) + "/" + link;
                }
                path = link + "/" + parts.slice(i + 1).join("/");
                continue linkloop;
              }
            }
            return { path: current_path, node: current };
          }
          throw new FS.ErrnoError(32);
        }, getPath(node) {
          var path;
          while (true) {
            if (FS.isRoot(node)) {
              var mount = node.mount.mountpoint;
              if (!path) return mount;
              return mount[mount.length - 1] !== "/" ? `${mount}/${path}` : mount + path;
            }
            path = path ? `${node.name}/${path}` : node.name;
            node = node.parent;
          }
        }, hashName(parentid, name) {
          var hash = 0;
          for (var i = 0; i < name.length; i++) {
            hash = (hash << 5) - hash + name.charCodeAt(i) | 0;
          }
          return (parentid + hash >>> 0) % FS.nameTable.length;
        }, hashAddNode(node) {
          var hash = FS.hashName(node.parent.id, node.name);
          node.name_next = FS.nameTable[hash];
          FS.nameTable[hash] = node;
        }, hashRemoveNode(node) {
          var hash = FS.hashName(node.parent.id, node.name);
          if (FS.nameTable[hash] === node) {
            FS.nameTable[hash] = node.name_next;
          } else {
            var current = FS.nameTable[hash];
            while (current) {
              if (current.name_next === node) {
                current.name_next = node.name_next;
                break;
              }
              current = current.name_next;
            }
          }
        }, lookupNode(parent, name) {
          var errCode = FS.mayLookup(parent);
          if (errCode) {
            throw new FS.ErrnoError(errCode);
          }
          var hash = FS.hashName(parent.id, name);
          for (var node = FS.nameTable[hash]; node; node = node.name_next) {
            var nodeName = node.name;
            if (node.parent.id === parent.id && nodeName === name) {
              return node;
            }
          }
          return FS.lookup(parent, name);
        }, createNode(parent, name, mode, rdev) {
          var node = new FS.FSNode(parent, name, mode, rdev);
          FS.hashAddNode(node);
          return node;
        }, destroyNode(node) {
          FS.hashRemoveNode(node);
        }, isRoot(node) {
          return node === node.parent;
        }, isMountpoint(node) {
          return !!node.mounted;
        }, isFile(mode) {
          return (mode & 61440) === 32768;
        }, isDir(mode) {
          return (mode & 61440) === 16384;
        }, isLink(mode) {
          return (mode & 61440) === 40960;
        }, isChrdev(mode) {
          return (mode & 61440) === 8192;
        }, isBlkdev(mode) {
          return (mode & 61440) === 24576;
        }, isFIFO(mode) {
          return (mode & 61440) === 4096;
        }, isSocket(mode) {
          return (mode & 49152) === 49152;
        }, flagsToPermissionString(flag) {
          var perms = ["r", "w", "rw"][flag & 3];
          if (flag & 512) {
            perms += "w";
          }
          return perms;
        }, nodePermissions(node, perms) {
          if (FS.ignorePermissions) {
            return 0;
          }
          if (perms.includes("r") && !(node.mode & 292)) {
            return 2;
          } else if (perms.includes("w") && !(node.mode & 146)) {
            return 2;
          } else if (perms.includes("x") && !(node.mode & 73)) {
            return 2;
          }
          return 0;
        }, mayLookup(dir) {
          if (!FS.isDir(dir.mode)) return 54;
          var errCode = FS.nodePermissions(dir, "x");
          if (errCode) return errCode;
          if (!dir.node_ops.lookup) return 2;
          return 0;
        }, mayCreate(dir, name) {
          if (!FS.isDir(dir.mode)) {
            return 54;
          }
          try {
            var node = FS.lookupNode(dir, name);
            return 20;
          } catch (e) {
          }
          return FS.nodePermissions(dir, "wx");
        }, mayDelete(dir, name, isdir) {
          var node;
          try {
            node = FS.lookupNode(dir, name);
          } catch (e) {
            return e.errno;
          }
          var errCode = FS.nodePermissions(dir, "wx");
          if (errCode) {
            return errCode;
          }
          if (isdir) {
            if (!FS.isDir(node.mode)) {
              return 54;
            }
            if (FS.isRoot(node) || FS.getPath(node) === FS.cwd()) {
              return 10;
            }
          } else {
            if (FS.isDir(node.mode)) {
              return 31;
            }
          }
          return 0;
        }, mayOpen(node, flags) {
          if (!node) {
            return 44;
          }
          if (FS.isLink(node.mode)) {
            return 32;
          } else if (FS.isDir(node.mode)) {
            if (FS.flagsToPermissionString(flags) !== "r" || flags & (512 | 64)) {
              return 31;
            }
          }
          return FS.nodePermissions(node, FS.flagsToPermissionString(flags));
        }, checkOpExists(op, err2) {
          if (!op) {
            throw new FS.ErrnoError(err2);
          }
          return op;
        }, MAX_OPEN_FDS: 4096, nextfd() {
          for (var fd = 0; fd <= FS.MAX_OPEN_FDS; fd++) {
            if (!FS.streams[fd]) {
              return fd;
            }
          }
          throw new FS.ErrnoError(33);
        }, getStreamChecked(fd) {
          var stream = FS.getStream(fd);
          if (!stream) {
            throw new FS.ErrnoError(8);
          }
          return stream;
        }, getStream: (fd) => FS.streams[fd], createStream(stream, fd = -1) {
          stream = Object.assign(new FS.FSStream(), stream);
          if (fd == -1) {
            fd = FS.nextfd();
          }
          stream.fd = fd;
          FS.streams[fd] = stream;
          return stream;
        }, closeStream(fd) {
          FS.streams[fd] = null;
        }, dupStream(origStream, fd = -1) {
          var stream = FS.createStream(origStream, fd);
          stream.stream_ops?.dup?.(stream);
          return stream;
        }, doSetAttr(stream, node, attr) {
          var setattr = stream?.stream_ops.setattr;
          var arg = setattr ? stream : node;
          setattr ??= node.node_ops.setattr;
          FS.checkOpExists(setattr, 63);
          setattr(arg, attr);
        }, chrdev_stream_ops: { open(stream) {
          var device = FS.getDevice(stream.node.rdev);
          stream.stream_ops = device.stream_ops;
          stream.stream_ops.open?.(stream);
        }, llseek() {
          throw new FS.ErrnoError(70);
        } }, major: (dev) => dev >> 8, minor: (dev) => dev & 255, makedev: (ma, mi) => ma << 8 | mi, registerDevice(dev, ops) {
          FS.devices[dev] = { stream_ops: ops };
        }, getDevice: (dev) => FS.devices[dev], getMounts(mount) {
          var mounts = [];
          var check = [mount];
          while (check.length) {
            var m = check.pop();
            mounts.push(m);
            check.push(...m.mounts);
          }
          return mounts;
        }, syncfs(populate, callback) {
          if (typeof populate == "function") {
            callback = populate;
            populate = false;
          }
          FS.syncFSRequests++;
          if (FS.syncFSRequests > 1) {
            err(`warning: ${FS.syncFSRequests} FS.syncfs operations in flight at once, probably just doing extra work`);
          }
          var mounts = FS.getMounts(FS.root.mount);
          var completed = 0;
          function doCallback(errCode) {
            FS.syncFSRequests--;
            return callback(errCode);
          }
          function done(errCode) {
            if (errCode) {
              if (!done.errored) {
                done.errored = true;
                return doCallback(errCode);
              }
              return;
            }
            if (++completed >= mounts.length) {
              doCallback(null);
            }
          }
          mounts.forEach((mount) => {
            if (!mount.type.syncfs) {
              return done(null);
            }
            mount.type.syncfs(mount, populate, done);
          });
        }, mount(type, opts, mountpoint) {
          var root = mountpoint === "/";
          var pseudo = !mountpoint;
          var node;
          if (root && FS.root) {
            throw new FS.ErrnoError(10);
          } else if (!root && !pseudo) {
            var lookup = FS.lookupPath(mountpoint, { follow_mount: false });
            mountpoint = lookup.path;
            node = lookup.node;
            if (FS.isMountpoint(node)) {
              throw new FS.ErrnoError(10);
            }
            if (!FS.isDir(node.mode)) {
              throw new FS.ErrnoError(54);
            }
          }
          var mount = { type, opts, mountpoint, mounts: [] };
          var mountRoot = type.mount(mount);
          mountRoot.mount = mount;
          mount.root = mountRoot;
          if (root) {
            FS.root = mountRoot;
          } else if (node) {
            node.mounted = mount;
            if (node.mount) {
              node.mount.mounts.push(mount);
            }
          }
          return mountRoot;
        }, unmount(mountpoint) {
          var lookup = FS.lookupPath(mountpoint, { follow_mount: false });
          if (!FS.isMountpoint(lookup.node)) {
            throw new FS.ErrnoError(28);
          }
          var node = lookup.node;
          var mount = node.mounted;
          var mounts = FS.getMounts(mount);
          Object.keys(FS.nameTable).forEach((hash) => {
            var current = FS.nameTable[hash];
            while (current) {
              var next = current.name_next;
              if (mounts.includes(current.mount)) {
                FS.destroyNode(current);
              }
              current = next;
            }
          });
          node.mounted = null;
          var idx = node.mount.mounts.indexOf(mount);
          node.mount.mounts.splice(idx, 1);
        }, lookup(parent, name) {
          return parent.node_ops.lookup(parent, name);
        }, mknod(path, mode, dev) {
          var lookup = FS.lookupPath(path, { parent: true });
          var parent = lookup.node;
          var name = PATH.basename(path);
          if (!name) {
            throw new FS.ErrnoError(28);
          }
          if (name === "." || name === "..") {
            throw new FS.ErrnoError(20);
          }
          var errCode = FS.mayCreate(parent, name);
          if (errCode) {
            throw new FS.ErrnoError(errCode);
          }
          if (!parent.node_ops.mknod) {
            throw new FS.ErrnoError(63);
          }
          return parent.node_ops.mknod(parent, name, mode, dev);
        }, statfs(path) {
          return FS.statfsNode(FS.lookupPath(path, { follow: true }).node);
        }, statfsStream(stream) {
          return FS.statfsNode(stream.node);
        }, statfsNode(node) {
          var rtn = { bsize: 4096, frsize: 4096, blocks: 1e6, bfree: 5e5, bavail: 5e5, files: FS.nextInode, ffree: FS.nextInode - 1, fsid: 42, flags: 2, namelen: 255 };
          if (node.node_ops.statfs) {
            Object.assign(rtn, node.node_ops.statfs(node.mount.opts.root));
          }
          return rtn;
        }, create(path, mode = 438) {
          mode &= 4095;
          mode |= 32768;
          return FS.mknod(path, mode, 0);
        }, mkdir(path, mode = 511) {
          mode &= 511 | 512;
          mode |= 16384;
          return FS.mknod(path, mode, 0);
        }, mkdirTree(path, mode) {
          var dirs = path.split("/");
          var d = "";
          for (var dir of dirs) {
            if (!dir) continue;
            if (d || PATH.isAbs(path)) d += "/";
            d += dir;
            try {
              FS.mkdir(d, mode);
            } catch (e) {
              if (e.errno != 20) throw e;
            }
          }
        }, mkdev(path, mode, dev) {
          if (typeof dev == "undefined") {
            dev = mode;
            mode = 438;
          }
          mode |= 8192;
          return FS.mknod(path, mode, dev);
        }, symlink(oldpath, newpath) {
          if (!PATH_FS.resolve(oldpath)) {
            throw new FS.ErrnoError(44);
          }
          var lookup = FS.lookupPath(newpath, { parent: true });
          var parent = lookup.node;
          if (!parent) {
            throw new FS.ErrnoError(44);
          }
          var newname = PATH.basename(newpath);
          var errCode = FS.mayCreate(parent, newname);
          if (errCode) {
            throw new FS.ErrnoError(errCode);
          }
          if (!parent.node_ops.symlink) {
            throw new FS.ErrnoError(63);
          }
          return parent.node_ops.symlink(parent, newname, oldpath);
        }, rename(old_path, new_path) {
          var old_dirname = PATH.dirname(old_path);
          var new_dirname = PATH.dirname(new_path);
          var old_name = PATH.basename(old_path);
          var new_name = PATH.basename(new_path);
          var lookup, old_dir, new_dir;
          lookup = FS.lookupPath(old_path, { parent: true });
          old_dir = lookup.node;
          lookup = FS.lookupPath(new_path, { parent: true });
          new_dir = lookup.node;
          if (!old_dir || !new_dir) throw new FS.ErrnoError(44);
          if (old_dir.mount !== new_dir.mount) {
            throw new FS.ErrnoError(75);
          }
          var old_node = FS.lookupNode(old_dir, old_name);
          var relative = PATH_FS.relative(old_path, new_dirname);
          if (relative.charAt(0) !== ".") {
            throw new FS.ErrnoError(28);
          }
          relative = PATH_FS.relative(new_path, old_dirname);
          if (relative.charAt(0) !== ".") {
            throw new FS.ErrnoError(55);
          }
          var new_node;
          try {
            new_node = FS.lookupNode(new_dir, new_name);
          } catch (e) {
          }
          if (old_node === new_node) {
            return;
          }
          var isdir = FS.isDir(old_node.mode);
          var errCode = FS.mayDelete(old_dir, old_name, isdir);
          if (errCode) {
            throw new FS.ErrnoError(errCode);
          }
          errCode = new_node ? FS.mayDelete(new_dir, new_name, isdir) : FS.mayCreate(new_dir, new_name);
          if (errCode) {
            throw new FS.ErrnoError(errCode);
          }
          if (!old_dir.node_ops.rename) {
            throw new FS.ErrnoError(63);
          }
          if (FS.isMountpoint(old_node) || new_node && FS.isMountpoint(new_node)) {
            throw new FS.ErrnoError(10);
          }
          if (new_dir !== old_dir) {
            errCode = FS.nodePermissions(old_dir, "w");
            if (errCode) {
              throw new FS.ErrnoError(errCode);
            }
          }
          FS.hashRemoveNode(old_node);
          try {
            old_dir.node_ops.rename(old_node, new_dir, new_name);
            old_node.parent = new_dir;
          } catch (e) {
            throw e;
          } finally {
            FS.hashAddNode(old_node);
          }
        }, rmdir(path) {
          var lookup = FS.lookupPath(path, { parent: true });
          var parent = lookup.node;
          var name = PATH.basename(path);
          var node = FS.lookupNode(parent, name);
          var errCode = FS.mayDelete(parent, name, true);
          if (errCode) {
            throw new FS.ErrnoError(errCode);
          }
          if (!parent.node_ops.rmdir) {
            throw new FS.ErrnoError(63);
          }
          if (FS.isMountpoint(node)) {
            throw new FS.ErrnoError(10);
          }
          parent.node_ops.rmdir(parent, name);
          FS.destroyNode(node);
        }, readdir(path) {
          var lookup = FS.lookupPath(path, { follow: true });
          var node = lookup.node;
          var readdir = FS.checkOpExists(node.node_ops.readdir, 54);
          return readdir(node);
        }, unlink(path) {
          var lookup = FS.lookupPath(path, { parent: true });
          var parent = lookup.node;
          if (!parent) {
            throw new FS.ErrnoError(44);
          }
          var name = PATH.basename(path);
          var node = FS.lookupNode(parent, name);
          var errCode = FS.mayDelete(parent, name, false);
          if (errCode) {
            throw new FS.ErrnoError(errCode);
          }
          if (!parent.node_ops.unlink) {
            throw new FS.ErrnoError(63);
          }
          if (FS.isMountpoint(node)) {
            throw new FS.ErrnoError(10);
          }
          parent.node_ops.unlink(parent, name);
          FS.destroyNode(node);
        }, readlink(path) {
          var lookup = FS.lookupPath(path);
          var link = lookup.node;
          if (!link) {
            throw new FS.ErrnoError(44);
          }
          if (!link.node_ops.readlink) {
            throw new FS.ErrnoError(28);
          }
          return link.node_ops.readlink(link);
        }, stat(path, dontFollow) {
          var lookup = FS.lookupPath(path, { follow: !dontFollow });
          var node = lookup.node;
          var getattr = FS.checkOpExists(node.node_ops.getattr, 63);
          return getattr(node);
        }, fstat(fd) {
          var stream = FS.getStreamChecked(fd);
          var node = stream.node;
          var getattr = stream.stream_ops.getattr;
          var arg = getattr ? stream : node;
          getattr ??= node.node_ops.getattr;
          FS.checkOpExists(getattr, 63);
          return getattr(arg);
        }, lstat(path) {
          return FS.stat(path, true);
        }, doChmod(stream, node, mode, dontFollow) {
          FS.doSetAttr(stream, node, { mode: mode & 4095 | node.mode & ~4095, ctime: Date.now(), dontFollow });
        }, chmod(path, mode, dontFollow) {
          var node;
          if (typeof path == "string") {
            var lookup = FS.lookupPath(path, { follow: !dontFollow });
            node = lookup.node;
          } else {
            node = path;
          }
          FS.doChmod(null, node, mode, dontFollow);
        }, lchmod(path, mode) {
          FS.chmod(path, mode, true);
        }, fchmod(fd, mode) {
          var stream = FS.getStreamChecked(fd);
          FS.doChmod(stream, stream.node, mode, false);
        }, doChown(stream, node, dontFollow) {
          FS.doSetAttr(stream, node, { timestamp: Date.now(), dontFollow });
        }, chown(path, uid, gid, dontFollow) {
          var node;
          if (typeof path == "string") {
            var lookup = FS.lookupPath(path, { follow: !dontFollow });
            node = lookup.node;
          } else {
            node = path;
          }
          FS.doChown(null, node, dontFollow);
        }, lchown(path, uid, gid) {
          FS.chown(path, uid, gid, true);
        }, fchown(fd, uid, gid) {
          var stream = FS.getStreamChecked(fd);
          FS.doChown(stream, stream.node, false);
        }, doTruncate(stream, node, len) {
          if (FS.isDir(node.mode)) {
            throw new FS.ErrnoError(31);
          }
          if (!FS.isFile(node.mode)) {
            throw new FS.ErrnoError(28);
          }
          var errCode = FS.nodePermissions(node, "w");
          if (errCode) {
            throw new FS.ErrnoError(errCode);
          }
          FS.doSetAttr(stream, node, { size: len, timestamp: Date.now() });
        }, truncate(path, len) {
          if (len < 0) {
            throw new FS.ErrnoError(28);
          }
          var node;
          if (typeof path == "string") {
            var lookup = FS.lookupPath(path, { follow: true });
            node = lookup.node;
          } else {
            node = path;
          }
          FS.doTruncate(null, node, len);
        }, ftruncate(fd, len) {
          var stream = FS.getStreamChecked(fd);
          if (len < 0 || (stream.flags & 2097155) === 0) {
            throw new FS.ErrnoError(28);
          }
          FS.doTruncate(stream, stream.node, len);
        }, utime(path, atime, mtime) {
          var lookup = FS.lookupPath(path, { follow: true });
          var node = lookup.node;
          var setattr = FS.checkOpExists(node.node_ops.setattr, 63);
          setattr(node, { atime, mtime });
        }, open(path, flags, mode = 438) {
          if (path === "") {
            throw new FS.ErrnoError(44);
          }
          flags = typeof flags == "string" ? FS_modeStringToFlags(flags) : flags;
          if (flags & 64) {
            mode = mode & 4095 | 32768;
          } else {
            mode = 0;
          }
          var node;
          var isDirPath;
          if (typeof path == "object") {
            node = path;
          } else {
            isDirPath = path.endsWith("/");
            var lookup = FS.lookupPath(path, { follow: !(flags & 131072), noent_okay: true });
            node = lookup.node;
            path = lookup.path;
          }
          var created = false;
          if (flags & 64) {
            if (node) {
              if (flags & 128) {
                throw new FS.ErrnoError(20);
              }
            } else if (isDirPath) {
              throw new FS.ErrnoError(31);
            } else {
              node = FS.mknod(path, mode | 511, 0);
              created = true;
            }
          }
          if (!node) {
            throw new FS.ErrnoError(44);
          }
          if (FS.isChrdev(node.mode)) {
            flags &= ~512;
          }
          if (flags & 65536 && !FS.isDir(node.mode)) {
            throw new FS.ErrnoError(54);
          }
          if (!created) {
            var errCode = FS.mayOpen(node, flags);
            if (errCode) {
              throw new FS.ErrnoError(errCode);
            }
          }
          if (flags & 512 && !created) {
            FS.truncate(node, 0);
          }
          flags &= ~(128 | 512 | 131072);
          var stream = FS.createStream({ node, path: FS.getPath(node), flags, seekable: true, position: 0, stream_ops: node.stream_ops, ungotten: [], error: false });
          if (stream.stream_ops.open) {
            stream.stream_ops.open(stream);
          }
          if (created) {
            FS.chmod(node, mode & 511);
          }
          if (Module["logReadFiles"] && !(flags & 1)) {
            if (!(path in FS.readFiles)) {
              FS.readFiles[path] = 1;
            }
          }
          return stream;
        }, close(stream) {
          if (FS.isClosed(stream)) {
            throw new FS.ErrnoError(8);
          }
          if (stream.getdents) stream.getdents = null;
          try {
            if (stream.stream_ops.close) {
              stream.stream_ops.close(stream);
            }
          } catch (e) {
            throw e;
          } finally {
            FS.closeStream(stream.fd);
          }
          stream.fd = null;
        }, isClosed(stream) {
          return stream.fd === null;
        }, llseek(stream, offset, whence) {
          if (FS.isClosed(stream)) {
            throw new FS.ErrnoError(8);
          }
          if (!stream.seekable || !stream.stream_ops.llseek) {
            throw new FS.ErrnoError(70);
          }
          if (whence != 0 && whence != 1 && whence != 2) {
            throw new FS.ErrnoError(28);
          }
          stream.position = stream.stream_ops.llseek(stream, offset, whence);
          stream.ungotten = [];
          return stream.position;
        }, read(stream, buffer, offset, length, position) {
          if (length < 0 || position < 0) {
            throw new FS.ErrnoError(28);
          }
          if (FS.isClosed(stream)) {
            throw new FS.ErrnoError(8);
          }
          if ((stream.flags & 2097155) === 1) {
            throw new FS.ErrnoError(8);
          }
          if (FS.isDir(stream.node.mode)) {
            throw new FS.ErrnoError(31);
          }
          if (!stream.stream_ops.read) {
            throw new FS.ErrnoError(28);
          }
          var seeking = typeof position != "undefined";
          if (!seeking) {
            position = stream.position;
          } else if (!stream.seekable) {
            throw new FS.ErrnoError(70);
          }
          var bytesRead = stream.stream_ops.read(stream, buffer, offset, length, position);
          if (!seeking) stream.position += bytesRead;
          return bytesRead;
        }, write(stream, buffer, offset, length, position, canOwn) {
          if (length < 0 || position < 0) {
            throw new FS.ErrnoError(28);
          }
          if (FS.isClosed(stream)) {
            throw new FS.ErrnoError(8);
          }
          if ((stream.flags & 2097155) === 0) {
            throw new FS.ErrnoError(8);
          }
          if (FS.isDir(stream.node.mode)) {
            throw new FS.ErrnoError(31);
          }
          if (!stream.stream_ops.write) {
            throw new FS.ErrnoError(28);
          }
          if (stream.seekable && stream.flags & 1024) {
            FS.llseek(stream, 0, 2);
          }
          var seeking = typeof position != "undefined";
          if (!seeking) {
            position = stream.position;
          } else if (!stream.seekable) {
            throw new FS.ErrnoError(70);
          }
          var bytesWritten = stream.stream_ops.write(stream, buffer, offset, length, position, canOwn);
          if (!seeking) stream.position += bytesWritten;
          return bytesWritten;
        }, mmap(stream, length, position, prot, flags) {
          if ((prot & 2) !== 0 && (flags & 2) === 0 && (stream.flags & 2097155) !== 2) {
            throw new FS.ErrnoError(2);
          }
          if ((stream.flags & 2097155) === 1) {
            throw new FS.ErrnoError(2);
          }
          if (!stream.stream_ops.mmap) {
            throw new FS.ErrnoError(43);
          }
          if (!length) {
            throw new FS.ErrnoError(28);
          }
          return stream.stream_ops.mmap(stream, length, position, prot, flags);
        }, msync(stream, buffer, offset, length, mmapFlags) {
          if (!stream.stream_ops.msync) {
            return 0;
          }
          return stream.stream_ops.msync(stream, buffer, offset, length, mmapFlags);
        }, ioctl(stream, cmd, arg) {
          if (!stream.stream_ops.ioctl) {
            throw new FS.ErrnoError(59);
          }
          return stream.stream_ops.ioctl(stream, cmd, arg);
        }, readFile(path, opts = {}) {
          opts.flags = opts.flags || 0;
          opts.encoding = opts.encoding || "binary";
          if (opts.encoding !== "utf8" && opts.encoding !== "binary") {
            throw new Error(`Invalid encoding type "${opts.encoding}"`);
          }
          var stream = FS.open(path, opts.flags);
          var stat = FS.stat(path);
          var length = stat.size;
          var buf = new Uint8Array(length);
          FS.read(stream, buf, 0, length, 0);
          if (opts.encoding === "utf8") {
            buf = UTF8ArrayToString(buf);
          }
          FS.close(stream);
          return buf;
        }, writeFile(path, data, opts = {}) {
          opts.flags = opts.flags || 577;
          var stream = FS.open(path, opts.flags, opts.mode);
          if (typeof data == "string") {
            data = new Uint8Array(intArrayFromString(data, true));
          }
          if (ArrayBuffer.isView(data)) {
            FS.write(stream, data, 0, data.byteLength, void 0, opts.canOwn);
          } else {
            throw new Error("Unsupported data type");
          }
          FS.close(stream);
        }, cwd: () => FS.currentPath, chdir(path) {
          var lookup = FS.lookupPath(path, { follow: true });
          if (lookup.node === null) {
            throw new FS.ErrnoError(44);
          }
          if (!FS.isDir(lookup.node.mode)) {
            throw new FS.ErrnoError(54);
          }
          var errCode = FS.nodePermissions(lookup.node, "x");
          if (errCode) {
            throw new FS.ErrnoError(errCode);
          }
          FS.currentPath = lookup.path;
        }, createDefaultDirectories() {
          FS.mkdir("/tmp");
          FS.mkdir("/home");
          FS.mkdir("/home/web_user");
        }, createDefaultDevices() {
          FS.mkdir("/dev");
          FS.registerDevice(FS.makedev(1, 3), { read: () => 0, write: (stream, buffer, offset, length, pos) => length, llseek: () => 0 });
          FS.mkdev("/dev/null", FS.makedev(1, 3));
          TTY.register(FS.makedev(5, 0), TTY.default_tty_ops);
          TTY.register(FS.makedev(6, 0), TTY.default_tty1_ops);
          FS.mkdev("/dev/tty", FS.makedev(5, 0));
          FS.mkdev("/dev/tty1", FS.makedev(6, 0));
          var randomBuffer = new Uint8Array(1024), randomLeft = 0;
          var randomByte = () => {
            if (randomLeft === 0) {
              randomFill(randomBuffer);
              randomLeft = randomBuffer.byteLength;
            }
            return randomBuffer[--randomLeft];
          };
          FS.createDevice("/dev", "random", randomByte);
          FS.createDevice("/dev", "urandom", randomByte);
          FS.mkdir("/dev/shm");
          FS.mkdir("/dev/shm/tmp");
        }, createSpecialDirectories() {
          FS.mkdir("/proc");
          var proc_self = FS.mkdir("/proc/self");
          FS.mkdir("/proc/self/fd");
          FS.mount({ mount() {
            var node = FS.createNode(proc_self, "fd", 16895, 73);
            node.stream_ops = { llseek: MEMFS.stream_ops.llseek };
            node.node_ops = { lookup(parent, name) {
              var fd = +name;
              var stream = FS.getStreamChecked(fd);
              var ret = { parent: null, mount: { mountpoint: "fake" }, node_ops: { readlink: () => stream.path }, id: fd + 1 };
              ret.parent = ret;
              return ret;
            }, readdir() {
              return Array.from(FS.streams.entries()).filter(([k, v]) => v).map(([k, v]) => k.toString());
            } };
            return node;
          } }, {}, "/proc/self/fd");
        }, createStandardStreams(input, output, error) {
          if (input) {
            FS.createDevice("/dev", "stdin", input);
          } else {
            FS.symlink("/dev/tty", "/dev/stdin");
          }
          if (output) {
            FS.createDevice("/dev", "stdout", null, output);
          } else {
            FS.symlink("/dev/tty", "/dev/stdout");
          }
          if (error) {
            FS.createDevice("/dev", "stderr", null, error);
          } else {
            FS.symlink("/dev/tty1", "/dev/stderr");
          }
          var stdin = FS.open("/dev/stdin", 0);
          var stdout = FS.open("/dev/stdout", 1);
          var stderr = FS.open("/dev/stderr", 1);
        }, staticInit() {
          FS.nameTable = new Array(4096);
          FS.mount(MEMFS, {}, "/");
          FS.createDefaultDirectories();
          FS.createDefaultDevices();
          FS.createSpecialDirectories();
          FS.filesystems = { MEMFS };
        }, init(input, output, error) {
          FS.initialized = true;
          input ??= Module["stdin"];
          output ??= Module["stdout"];
          error ??= Module["stderr"];
          FS.createStandardStreams(input, output, error);
        }, quit() {
          FS.initialized = false;
          for (var stream of FS.streams) {
            if (stream) {
              FS.close(stream);
            }
          }
        }, findObject(path, dontResolveLastLink) {
          var ret = FS.analyzePath(path, dontResolveLastLink);
          if (!ret.exists) {
            return null;
          }
          return ret.object;
        }, analyzePath(path, dontResolveLastLink) {
          try {
            var lookup = FS.lookupPath(path, { follow: !dontResolveLastLink });
            path = lookup.path;
          } catch (e) {
          }
          var ret = { isRoot: false, exists: false, error: 0, name: null, path: null, object: null, parentExists: false, parentPath: null, parentObject: null };
          try {
            var lookup = FS.lookupPath(path, { parent: true });
            ret.parentExists = true;
            ret.parentPath = lookup.path;
            ret.parentObject = lookup.node;
            ret.name = PATH.basename(path);
            lookup = FS.lookupPath(path, { follow: !dontResolveLastLink });
            ret.exists = true;
            ret.path = lookup.path;
            ret.object = lookup.node;
            ret.name = lookup.node.name;
            ret.isRoot = lookup.path === "/";
          } catch (e) {
            ret.error = e.errno;
          }
          return ret;
        }, createPath(parent, path, canRead, canWrite) {
          parent = typeof parent == "string" ? parent : FS.getPath(parent);
          var parts = path.split("/").reverse();
          while (parts.length) {
            var part = parts.pop();
            if (!part) continue;
            var current = PATH.join2(parent, part);
            try {
              FS.mkdir(current);
            } catch (e) {
              if (e.errno != 20) throw e;
            }
            parent = current;
          }
          return current;
        }, createFile(parent, name, properties, canRead, canWrite) {
          var path = PATH.join2(typeof parent == "string" ? parent : FS.getPath(parent), name);
          var mode = FS_getMode(canRead, canWrite);
          return FS.create(path, mode);
        }, createDataFile(parent, name, data, canRead, canWrite, canOwn) {
          var path = name;
          if (parent) {
            parent = typeof parent == "string" ? parent : FS.getPath(parent);
            path = name ? PATH.join2(parent, name) : parent;
          }
          var mode = FS_getMode(canRead, canWrite);
          var node = FS.create(path, mode);
          if (data) {
            if (typeof data == "string") {
              var arr = new Array(data.length);
              for (var i = 0, len = data.length; i < len; ++i) arr[i] = data.charCodeAt(i);
              data = arr;
            }
            FS.chmod(node, mode | 146);
            var stream = FS.open(node, 577);
            FS.write(stream, data, 0, data.length, 0, canOwn);
            FS.close(stream);
            FS.chmod(node, mode);
          }
        }, createDevice(parent, name, input, output) {
          var path = PATH.join2(typeof parent == "string" ? parent : FS.getPath(parent), name);
          var mode = FS_getMode(!!input, !!output);
          FS.createDevice.major ??= 64;
          var dev = FS.makedev(FS.createDevice.major++, 0);
          FS.registerDevice(dev, { open(stream) {
            stream.seekable = false;
          }, close(stream) {
            if (output?.buffer?.length) {
              output(10);
            }
          }, read(stream, buffer, offset, length, pos) {
            var bytesRead = 0;
            for (var i = 0; i < length; i++) {
              var result;
              try {
                result = input();
              } catch (e) {
                throw new FS.ErrnoError(29);
              }
              if (result === void 0 && bytesRead === 0) {
                throw new FS.ErrnoError(6);
              }
              if (result === null || result === void 0) break;
              bytesRead++;
              buffer[offset + i] = result;
            }
            if (bytesRead) {
              stream.node.atime = Date.now();
            }
            return bytesRead;
          }, write(stream, buffer, offset, length, pos) {
            for (var i = 0; i < length; i++) {
              try {
                output(buffer[offset + i]);
              } catch (e) {
                throw new FS.ErrnoError(29);
              }
            }
            if (length) {
              stream.node.mtime = stream.node.ctime = Date.now();
            }
            return i;
          } });
          return FS.mkdev(path, mode, dev);
        }, forceLoadFile(obj) {
          if (obj.isDevice || obj.isFolder || obj.link || obj.contents) return true;
          if (typeof XMLHttpRequest != "undefined") {
            throw new Error("Lazy loading should have been performed (contents set) in createLazyFile, but it was not. Lazy loading only works in web workers. Use --embed-file or --preload-file in emcc on the main thread.");
          } else {
            try {
              obj.contents = readBinary(obj.url);
              obj.usedBytes = obj.contents.length;
            } catch (e) {
              throw new FS.ErrnoError(29);
            }
          }
        }, createLazyFile(parent, name, url, canRead, canWrite) {
          class LazyUint8Array {
            lengthKnown = false;
            chunks = [];
            get(idx) {
              if (idx > this.length - 1 || idx < 0) {
                return void 0;
              }
              var chunkOffset = idx % this.chunkSize;
              var chunkNum = idx / this.chunkSize | 0;
              return this.getter(chunkNum)[chunkOffset];
            }
            setDataGetter(getter) {
              this.getter = getter;
            }
            cacheLength() {
              var xhr = new XMLHttpRequest();
              xhr.open("HEAD", url, false);
              xhr.send(null);
              if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
              var datalength = Number(xhr.getResponseHeader("Content-length"));
              var header;
              var hasByteServing = (header = xhr.getResponseHeader("Accept-Ranges")) && header === "bytes";
              var usesGzip = (header = xhr.getResponseHeader("Content-Encoding")) && header === "gzip";
              var chunkSize = 1024 * 1024;
              if (!hasByteServing) chunkSize = datalength;
              var doXHR = (from, to) => {
                if (from > to) throw new Error("invalid range (" + from + ", " + to + ") or no bytes requested!");
                if (to > datalength - 1) throw new Error("only " + datalength + " bytes available! programmer error!");
                var xhr2 = new XMLHttpRequest();
                xhr2.open("GET", url, false);
                if (datalength !== chunkSize) xhr2.setRequestHeader("Range", "bytes=" + from + "-" + to);
                xhr2.responseType = "arraybuffer";
                if (xhr2.overrideMimeType) {
                  xhr2.overrideMimeType("text/plain; charset=x-user-defined");
                }
                xhr2.send(null);
                if (!(xhr2.status >= 200 && xhr2.status < 300 || xhr2.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr2.status);
                if (xhr2.response !== void 0) {
                  return new Uint8Array(xhr2.response || []);
                }
                return intArrayFromString(xhr2.responseText || "", true);
              };
              var lazyArray2 = this;
              lazyArray2.setDataGetter((chunkNum) => {
                var start = chunkNum * chunkSize;
                var end = (chunkNum + 1) * chunkSize - 1;
                end = Math.min(end, datalength - 1);
                if (typeof lazyArray2.chunks[chunkNum] == "undefined") {
                  lazyArray2.chunks[chunkNum] = doXHR(start, end);
                }
                if (typeof lazyArray2.chunks[chunkNum] == "undefined") throw new Error("doXHR failed!");
                return lazyArray2.chunks[chunkNum];
              });
              if (usesGzip || !datalength) {
                chunkSize = datalength = 1;
                datalength = this.getter(0).length;
                chunkSize = datalength;
                out("LazyFiles on gzip forces download of the whole file when length is accessed");
              }
              this._length = datalength;
              this._chunkSize = chunkSize;
              this.lengthKnown = true;
            }
            get length() {
              if (!this.lengthKnown) {
                this.cacheLength();
              }
              return this._length;
            }
            get chunkSize() {
              if (!this.lengthKnown) {
                this.cacheLength();
              }
              return this._chunkSize;
            }
          }
          if (typeof XMLHttpRequest != "undefined") {
            if (!ENVIRONMENT_IS_WORKER) throw "Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc";
            var lazyArray = new LazyUint8Array();
            var properties = { isDevice: false, contents: lazyArray };
          } else {
            var properties = { isDevice: false, url };
          }
          var node = FS.createFile(parent, name, properties, canRead, canWrite);
          if (properties.contents) {
            node.contents = properties.contents;
          } else if (properties.url) {
            node.contents = null;
            node.url = properties.url;
          }
          Object.defineProperties(node, { usedBytes: { get: function() {
            return this.contents.length;
          } } });
          var stream_ops = {};
          var keys = Object.keys(node.stream_ops);
          keys.forEach((key) => {
            var fn = node.stream_ops[key];
            stream_ops[key] = (...args) => {
              FS.forceLoadFile(node);
              return fn(...args);
            };
          });
          function writeChunks(stream, buffer, offset, length, position) {
            var contents = stream.node.contents;
            if (position >= contents.length) return 0;
            var size = Math.min(contents.length - position, length);
            if (contents.slice) {
              for (var i = 0; i < size; i++) {
                buffer[offset + i] = contents[position + i];
              }
            } else {
              for (var i = 0; i < size; i++) {
                buffer[offset + i] = contents.get(position + i);
              }
            }
            return size;
          }
          stream_ops.read = (stream, buffer, offset, length, position) => {
            FS.forceLoadFile(node);
            return writeChunks(stream, buffer, offset, length, position);
          };
          stream_ops.mmap = (stream, length, position, prot, flags) => {
            FS.forceLoadFile(node);
            var ptr = mmapAlloc(length);
            if (!ptr) {
              throw new FS.ErrnoError(48);
            }
            writeChunks(stream, HEAP8, ptr, length, position);
            return { ptr, allocated: true };
          };
          node.stream_ops = stream_ops;
          return node;
        } };
        var UTF8ToString = (ptr, maxBytesToRead) => ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : "";
        var SYSCALLS = { DEFAULT_POLLMASK: 5, calculateAt(dirfd, path, allowEmpty) {
          if (PATH.isAbs(path)) {
            return path;
          }
          var dir;
          if (dirfd === -100) {
            dir = FS.cwd();
          } else {
            var dirstream = SYSCALLS.getStreamFromFD(dirfd);
            dir = dirstream.path;
          }
          if (path.length == 0) {
            if (!allowEmpty) {
              throw new FS.ErrnoError(44);
            }
            return dir;
          }
          return dir + "/" + path;
        }, writeStat(buf, stat) {
          HEAP32[buf >> 2] = stat.dev;
          HEAP32[buf + 4 >> 2] = stat.mode;
          HEAPU32[buf + 8 >> 2] = stat.nlink;
          HEAP32[buf + 12 >> 2] = stat.uid;
          HEAP32[buf + 16 >> 2] = stat.gid;
          HEAP32[buf + 20 >> 2] = stat.rdev;
          HEAP64[buf + 24 >> 3] = BigInt(stat.size);
          HEAP32[buf + 32 >> 2] = 4096;
          HEAP32[buf + 36 >> 2] = stat.blocks;
          var atime = stat.atime.getTime();
          var mtime = stat.mtime.getTime();
          var ctime = stat.ctime.getTime();
          HEAP64[buf + 40 >> 3] = BigInt(Math.floor(atime / 1e3));
          HEAPU32[buf + 48 >> 2] = atime % 1e3 * 1e3 * 1e3;
          HEAP64[buf + 56 >> 3] = BigInt(Math.floor(mtime / 1e3));
          HEAPU32[buf + 64 >> 2] = mtime % 1e3 * 1e3 * 1e3;
          HEAP64[buf + 72 >> 3] = BigInt(Math.floor(ctime / 1e3));
          HEAPU32[buf + 80 >> 2] = ctime % 1e3 * 1e3 * 1e3;
          HEAP64[buf + 88 >> 3] = BigInt(stat.ino);
          return 0;
        }, writeStatFs(buf, stats) {
          HEAP32[buf + 4 >> 2] = stats.bsize;
          HEAP32[buf + 40 >> 2] = stats.bsize;
          HEAP32[buf + 8 >> 2] = stats.blocks;
          HEAP32[buf + 12 >> 2] = stats.bfree;
          HEAP32[buf + 16 >> 2] = stats.bavail;
          HEAP32[buf + 20 >> 2] = stats.files;
          HEAP32[buf + 24 >> 2] = stats.ffree;
          HEAP32[buf + 28 >> 2] = stats.fsid;
          HEAP32[buf + 44 >> 2] = stats.flags;
          HEAP32[buf + 36 >> 2] = stats.namelen;
        }, doMsync(addr, stream, len, flags, offset) {
          if (!FS.isFile(stream.node.mode)) {
            throw new FS.ErrnoError(43);
          }
          if (flags & 2) {
            return 0;
          }
          var buffer = HEAPU8.slice(addr, addr + len);
          FS.msync(stream, buffer, offset, len, flags);
        }, getStreamFromFD(fd) {
          var stream = FS.getStreamChecked(fd);
          return stream;
        }, varargs: void 0, getStr(ptr) {
          var ret = UTF8ToString(ptr);
          return ret;
        } };
        function _fd_close(fd) {
          try {
            var stream = SYSCALLS.getStreamFromFD(fd);
            FS.close(stream);
            return 0;
          } catch (e) {
            if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
            return e.errno;
          }
        }
        var doReadv = (stream, iov, iovcnt, offset) => {
          var ret = 0;
          for (var i = 0; i < iovcnt; i++) {
            var ptr = HEAPU32[iov >> 2];
            var len = HEAPU32[iov + 4 >> 2];
            iov += 8;
            var curr = FS.read(stream, HEAP8, ptr, len, offset);
            if (curr < 0) return -1;
            ret += curr;
            if (curr < len) break;
            if (typeof offset != "undefined") {
              offset += curr;
            }
          }
          return ret;
        };
        function _fd_read(fd, iov, iovcnt, pnum) {
          try {
            var stream = SYSCALLS.getStreamFromFD(fd);
            var num = doReadv(stream, iov, iovcnt);
            HEAPU32[pnum >> 2] = num;
            return 0;
          } catch (e) {
            if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
            return e.errno;
          }
        }
        var INT53_MAX = 9007199254740992;
        var INT53_MIN = -9007199254740992;
        var bigintToI53Checked = (num) => num < INT53_MIN || num > INT53_MAX ? NaN : Number(num);
        function _fd_seek(fd, offset, whence, newOffset) {
          offset = bigintToI53Checked(offset);
          try {
            if (isNaN(offset)) return 61;
            var stream = SYSCALLS.getStreamFromFD(fd);
            FS.llseek(stream, offset, whence);
            HEAP64[newOffset >> 3] = BigInt(stream.position);
            if (stream.getdents && offset === 0 && whence === 0) stream.getdents = null;
            return 0;
          } catch (e) {
            if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
            return e.errno;
          }
        }
        var doWritev = (stream, iov, iovcnt, offset) => {
          var ret = 0;
          for (var i = 0; i < iovcnt; i++) {
            var ptr = HEAPU32[iov >> 2];
            var len = HEAPU32[iov + 4 >> 2];
            iov += 8;
            var curr = FS.write(stream, HEAP8, ptr, len, offset);
            if (curr < 0) return -1;
            ret += curr;
            if (curr < len) {
              break;
            }
            if (typeof offset != "undefined") {
              offset += curr;
            }
          }
          return ret;
        };
        function _fd_write(fd, iov, iovcnt, pnum) {
          try {
            var stream = SYSCALLS.getStreamFromFD(fd);
            var num = doWritev(stream, iov, iovcnt);
            HEAPU32[pnum >> 2] = num;
            return 0;
          } catch (e) {
            if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
            return e.errno;
          }
        }
        var wasmTableMirror = [];
        var wasmTable;
        var getWasmTableEntry = (funcPtr) => {
          var func = wasmTableMirror[funcPtr];
          if (!func) {
            wasmTableMirror[funcPtr] = func = wasmTable.get(funcPtr);
          }
          return func;
        };
        var stringToUTF8 = (str, outPtr, maxBytesToWrite) => stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite);
        FS.createPreloadedFile = FS_createPreloadedFile;
        FS.staticInit();
        MEMFS.doesNotExistError = new FS.ErrnoError(44);
        MEMFS.doesNotExistError.stack = "<generic error, no stack>";
        {
          if (Module["noExitRuntime"]) noExitRuntime = Module["noExitRuntime"];
          if (Module["preloadPlugins"]) preloadPlugins = Module["preloadPlugins"];
          if (Module["print"]) out = Module["print"];
          if (Module["printErr"]) err = Module["printErr"];
          if (Module["wasmBinary"]) wasmBinary = Module["wasmBinary"];
          if (Module["arguments"]) arguments_ = Module["arguments"];
          if (Module["thisProgram"]) thisProgram = Module["thisProgram"];
        }
        Module["getValue"] = getValue;
        Module["UTF8ToString"] = UTF8ToString;
        Module["stringToUTF8"] = stringToUTF8;
        Module["lengthBytesUTF8"] = lengthBytesUTF8;
        var _wasm_parse_query_raw, _malloc, _free, _wasm_free_parse_result, __emscripten_timeout, _setThrew, __emscripten_stack_restore, _emscripten_stack_get_current;
        function assignWasmExports(wasmExports2) {
          Module["_wasm_parse_query_raw"] = _wasm_parse_query_raw = wasmExports2["r"];
          Module["_malloc"] = _malloc = wasmExports2["s"];
          Module["_free"] = _free = wasmExports2["u"];
          Module["_wasm_free_parse_result"] = _wasm_free_parse_result = wasmExports2["v"];
          __emscripten_timeout = wasmExports2["w"];
          _setThrew = wasmExports2["x"];
          __emscripten_stack_restore = wasmExports2["y"];
          _emscripten_stack_get_current = wasmExports2["z"];
        }
        var wasmImports = { g: __abort_js, k: __emscripten_runtime_keepalive_clear, m: __emscripten_throw_longjmp, l: __setitimer_js, n: _emscripten_resize_heap, b: _exit, f: _fd_close, c: _fd_read, d: _fd_seek, e: _fd_write, i: invoke_i, a: invoke_ii, o: invoke_iii, h: invoke_v, j: _proc_exit };
        var wasmExports = await createWasm();
        function invoke_iii(index, a1, a2) {
          var sp = stackSave();
          try {
            return getWasmTableEntry(index)(a1, a2);
          } catch (e) {
            stackRestore(sp);
            if (e !== e + 0) throw e;
            _setThrew(1, 0);
          }
        }
        function invoke_ii(index, a1) {
          var sp = stackSave();
          try {
            return getWasmTableEntry(index)(a1);
          } catch (e) {
            stackRestore(sp);
            if (e !== e + 0) throw e;
            _setThrew(1, 0);
          }
        }
        function invoke_i(index) {
          var sp = stackSave();
          try {
            return getWasmTableEntry(index)();
          } catch (e) {
            stackRestore(sp);
            if (e !== e + 0) throw e;
            _setThrew(1, 0);
          }
        }
        function invoke_v(index) {
          var sp = stackSave();
          try {
            getWasmTableEntry(index)();
          } catch (e) {
            stackRestore(sp);
            if (e !== e + 0) throw e;
            _setThrew(1, 0);
          }
        }
        function run2() {
          if (runDependencies > 0) {
            dependenciesFulfilled = run2;
            return;
          }
          preRun();
          if (runDependencies > 0) {
            dependenciesFulfilled = run2;
            return;
          }
          function doRun() {
            Module["calledRun"] = true;
            if (ABORT) return;
            initRuntime();
            readyPromiseResolve?.(Module);
            Module["onRuntimeInitialized"]?.();
            postRun();
          }
          if (Module["setStatus"]) {
            Module["setStatus"]("Running...");
            setTimeout(() => {
              setTimeout(() => Module["setStatus"](""), 1);
              doRun();
            }, 1);
          } else {
            doRun();
          }
        }
        function preInit() {
          if (Module["preInit"]) {
            if (typeof Module["preInit"] == "function") Module["preInit"] = [Module["preInit"]];
            while (Module["preInit"].length > 0) {
              Module["preInit"].shift()();
            }
          }
        }
        preInit();
        run2();
        if (runtimeInitialized) {
          moduleRtn = Module;
        } else {
          moduleRtn = new Promise((resolve2, reject) => {
            readyPromiseResolve = resolve2;
            readyPromiseReject = reject;
          });
        }
        return moduleRtn;
      });
    })();
    if (typeof exports2 === "object" && typeof module2 === "object") {
      module2.exports = PgQueryModule;
      module2.exports.default = PgQueryModule;
    } else if (typeof define === "function" && define["amd"])
      define([], () => PgQueryModule);
  }
});

// node_modules/libpg-query/wasm/index.cjs
var require_wasm = __commonJS({
  "node_modules/libpg-query/wasm/index.cjs"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __exportStar = exports2 && exports2.__exportStar || function(m, exports3) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports3, p)) __createBinding(exports3, m, p);
    };
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.parse = exports2.SqlError = void 0;
    exports2.formatSqlError = formatSqlError;
    exports2.hasSqlDetails = hasSqlDetails;
    exports2.loadModule = loadModule3;
    exports2.parseSync = parseSync3;
    __exportStar(require_types2(), exports2);
    var libpg_query_js_1 = __importDefault(require_libpg_query());
    var wasmModule;
    var SqlError = class extends Error {
      sqlDetails;
      constructor(message, details) {
        super(message);
        this.name = "SqlError";
        this.sqlDetails = details;
      }
    };
    exports2.SqlError = SqlError;
    function formatSqlError(error, query, options = {}) {
      const { showPosition = true, showQuery = true, color = false, maxQueryLength } = options;
      const lines = [];
      const red = color ? "\x1B[31m" : "";
      const yellow = color ? "\x1B[33m" : "";
      const reset = color ? "\x1B[0m" : "";
      lines.push(`${red}Error: ${error.message}${reset}`);
      if (error.sqlDetails) {
        const { cursorPosition, fileName, functionName, lineNumber } = error.sqlDetails;
        if (cursorPosition !== void 0 && cursorPosition >= 0) {
          lines.push(`Position: ${cursorPosition}`);
        }
        if (fileName || functionName || lineNumber) {
          const details = [];
          if (fileName)
            details.push(`file: ${fileName}`);
          if (functionName)
            details.push(`function: ${functionName}`);
          if (lineNumber)
            details.push(`line: ${lineNumber}`);
          lines.push(`Source: ${details.join(", ")}`);
        }
        if (showQuery && showPosition && cursorPosition !== void 0 && cursorPosition >= 0) {
          let displayQuery = query;
          if (maxQueryLength && query.length > maxQueryLength) {
            const start = Math.max(0, cursorPosition - Math.floor(maxQueryLength / 2));
            const end = Math.min(query.length, start + maxQueryLength);
            displayQuery = (start > 0 ? "..." : "") + query.substring(start, end) + (end < query.length ? "..." : "");
            const adjustedPosition = cursorPosition - start + (start > 0 ? 3 : 0);
            lines.push(displayQuery);
            lines.push(" ".repeat(adjustedPosition) + `${yellow}^${reset}`);
          } else {
            lines.push(displayQuery);
            lines.push(" ".repeat(cursorPosition) + `${yellow}^${reset}`);
          }
        }
      } else if (showQuery) {
        let displayQuery = query;
        if (maxQueryLength && query.length > maxQueryLength) {
          displayQuery = query.substring(0, maxQueryLength) + "...";
        }
        lines.push(`Query: ${displayQuery}`);
      }
      return lines.join("\n");
    }
    function hasSqlDetails(error) {
      return error instanceof Error && "sqlDetails" in error && typeof error.sqlDetails === "object" && error.sqlDetails !== null && "message" in error.sqlDetails && "cursorPosition" in error.sqlDetails;
    }
    var initPromise = (0, libpg_query_js_1.default)().then((module3) => {
      wasmModule = module3;
    });
    function ensureLoaded() {
      if (!wasmModule)
        throw new Error("WASM module not initialized. Call `loadModule()` first.");
    }
    async function loadModule3() {
      if (!wasmModule) {
        await initPromise;
      }
    }
    function awaitInit(fn) {
      return (async (...args) => {
        await initPromise;
        return fn(...args);
      });
    }
    function stringToPtr(str) {
      ensureLoaded();
      if (typeof str !== "string") {
        throw new TypeError(`Expected a string, got ${typeof str}`);
      }
      const len = wasmModule.lengthBytesUTF8(str) + 1;
      const ptr = wasmModule._malloc(len);
      try {
        wasmModule.stringToUTF8(str, ptr, len);
        return ptr;
      } catch (error) {
        wasmModule._free(ptr);
        throw error;
      }
    }
    exports2.parse = awaitInit(async (query) => {
      if (query === null || query === void 0) {
        throw new Error("Query cannot be null or undefined");
      }
      if (typeof query !== "string") {
        throw new Error(`Query must be a string, got ${typeof query}`);
      }
      if (query.trim() === "") {
        throw new Error("Query cannot be empty");
      }
      const queryPtr = stringToPtr(query);
      let resultPtr = 0;
      try {
        resultPtr = wasmModule._wasm_parse_query_raw(queryPtr);
        if (!resultPtr) {
          throw new Error("Failed to allocate memory for parse result");
        }
        const parseTreePtr = wasmModule.getValue(resultPtr, "i32");
        const stderrBufferPtr = wasmModule.getValue(resultPtr + 4, "i32");
        const errorPtr = wasmModule.getValue(resultPtr + 8, "i32");
        if (errorPtr) {
          const messagePtr = wasmModule.getValue(errorPtr, "i32");
          const funcnamePtr = wasmModule.getValue(errorPtr + 4, "i32");
          const filenamePtr = wasmModule.getValue(errorPtr + 8, "i32");
          const lineno = wasmModule.getValue(errorPtr + 12, "i32");
          const cursorpos = wasmModule.getValue(errorPtr + 16, "i32");
          const contextPtr = wasmModule.getValue(errorPtr + 20, "i32");
          const message = messagePtr ? wasmModule.UTF8ToString(messagePtr) : "Unknown error";
          const filename = filenamePtr ? wasmModule.UTF8ToString(filenamePtr) : null;
          const errorDetails = {
            message,
            cursorPosition: cursorpos > 0 ? cursorpos - 1 : 0,
            // Convert to 0-based
            fileName: filename || void 0,
            functionName: funcnamePtr ? wasmModule.UTF8ToString(funcnamePtr) : void 0,
            lineNumber: lineno > 0 ? lineno : void 0,
            context: contextPtr ? wasmModule.UTF8ToString(contextPtr) : void 0
          };
          throw new SqlError(message, errorDetails);
        }
        if (!parseTreePtr) {
          throw new Error("Parse result is null");
        }
        const parseTree = wasmModule.UTF8ToString(parseTreePtr);
        return JSON.parse(parseTree);
      } finally {
        wasmModule._free(queryPtr);
        if (resultPtr) {
          wasmModule._wasm_free_parse_result(resultPtr);
        }
      }
    });
    function parseSync3(query) {
      if (query === null || query === void 0) {
        throw new Error("Query cannot be null or undefined");
      }
      if (typeof query !== "string") {
        throw new Error(`Query must be a string, got ${typeof query}`);
      }
      if (query.trim() === "") {
        throw new Error("Query cannot be empty");
      }
      const queryPtr = stringToPtr(query);
      let resultPtr = 0;
      try {
        resultPtr = wasmModule._wasm_parse_query_raw(queryPtr);
        if (!resultPtr) {
          throw new Error("Failed to allocate memory for parse result");
        }
        const parseTreePtr = wasmModule.getValue(resultPtr, "i32");
        const stderrBufferPtr = wasmModule.getValue(resultPtr + 4, "i32");
        const errorPtr = wasmModule.getValue(resultPtr + 8, "i32");
        if (errorPtr) {
          const messagePtr = wasmModule.getValue(errorPtr, "i32");
          const funcnamePtr = wasmModule.getValue(errorPtr + 4, "i32");
          const filenamePtr = wasmModule.getValue(errorPtr + 8, "i32");
          const lineno = wasmModule.getValue(errorPtr + 12, "i32");
          const cursorpos = wasmModule.getValue(errorPtr + 16, "i32");
          const contextPtr = wasmModule.getValue(errorPtr + 20, "i32");
          const message = messagePtr ? wasmModule.UTF8ToString(messagePtr) : "Unknown error";
          const filename = filenamePtr ? wasmModule.UTF8ToString(filenamePtr) : null;
          const errorDetails = {
            message,
            cursorPosition: cursorpos > 0 ? cursorpos - 1 : 0,
            // Convert to 0-based
            fileName: filename || void 0,
            functionName: funcnamePtr ? wasmModule.UTF8ToString(funcnamePtr) : void 0,
            lineNumber: lineno > 0 ? lineno : void 0,
            context: contextPtr ? wasmModule.UTF8ToString(contextPtr) : void 0
          };
          throw new SqlError(message, errorDetails);
        }
        if (!parseTreePtr) {
          throw new Error("Parse result is null");
        }
        const parseTree = wasmModule.UTF8ToString(parseTreePtr);
        return JSON.parse(parseTree);
      } finally {
        wasmModule._free(queryPtr);
        if (resultPtr) {
          wasmModule._wasm_free_parse_result(resultPtr);
        }
      }
    }
  }
});

// scripts/mvp-migration/schema-loader.ts
var schema_loader_exports = {};
__export(schema_loader_exports, {
  applyMigrationSQL: () => applyMigrationSQL,
  applyOp: () => applyOp,
  applyStatement: () => applyStatement,
  buildSchemaFromSQL: () => buildSchemaFromSQL,
  createEmptySchema: () => createEmptySchema,
  normalizeName: () => normalizeName,
  printSchema: () => printSchema
});
function createEmptySchema() {
  return { tables: /* @__PURE__ */ new Map() };
}
function ensureTable(schema, name) {
  const norm = normalizeName(name);
  let table = schema.tables.get(norm);
  if (!table) {
    table = {
      columns: /* @__PURE__ */ new Map(),
      pk: void 0,
      uniqueConstraints: [],
      fkOut: [],
      fkIn: [],
      indexes: []
    };
    schema.tables.set(norm, table);
  }
  return table;
}
function normalizeName(name) {
  let n = name.replace(/^"|"$/g, "").toLowerCase();
  if (n.startsWith("public.")) n = n.slice(7);
  return n;
}
function formatRangeVar(rel) {
  if (!rel) return "(unknown)";
  const schema = rel.schemaname ? `${rel.schemaname}.` : "";
  return normalizeName(`${schema}${rel.relname}`);
}
function extractTypeName(tn) {
  if (!tn) return "unknown";
  const names = (tn.TypeName?.names || tn.names || []).map((n) => n.String?.sval || "?").filter((n) => n !== "pg_catalog");
  return names.join(".") || "unknown";
}
function applyStatement(schema, stmt) {
  const stmtType = Object.keys(stmt)[0];
  const detail = stmt[stmtType];
  switch (stmtType) {
    case "CreateStmt":
      applyCreateTable(schema, detail);
      break;
    case "AlterTableStmt":
      applyAlterTable(schema, detail);
      break;
    case "DropStmt":
      applyDrop(schema, detail);
      break;
    case "RenameStmt":
      applyRename(schema, detail);
      break;
    case "IndexStmt":
      applyCreateIndex(schema, detail);
      break;
  }
}
function applyCreateTable(schema, detail) {
  const tableName = formatRangeVar(detail.relation);
  const table = ensureTable(schema, tableName);
  for (const elt of detail.tableElts || []) {
    if (elt.ColumnDef) {
      const col = elt.ColumnDef;
      const colName = normalizeName(col.colname);
      const colType = extractTypeName(col.typeName);
      const constraints = col.constraints || [];
      const nullable = !constraints.some((c) => c.Constraint?.contype === "CONSTR_NOTNULL");
      const hasDefault = constraints.some((c) => c.Constraint?.contype === "CONSTR_DEFAULT");
      const identity = constraints.some((c) => c.Constraint?.contype === "CONSTR_IDENTITY");
      table.columns.set(colName, { type: colType, nullable: nullable && !identity, hasDefault: hasDefault || identity });
      if (constraints.some((c) => c.Constraint?.contype === "CONSTR_PRIMARY")) {
        table.pk = table.pk ? [...table.pk, colName] : [colName];
      }
      if (constraints.some((c) => c.Constraint?.contype === "CONSTR_UNIQUE")) {
        table.uniqueConstraints.push({ columns: [colName] });
      }
      for (const c of constraints) {
        if (c.Constraint?.contype === "CONSTR_FOREIGN") {
          addForeignKey(schema, tableName, table, c.Constraint);
        }
      }
    }
    if (elt.Constraint) {
      const con = elt.Constraint;
      switch (con.contype) {
        case "CONSTR_PRIMARY": {
          const cols = (con.keys || []).map((k) => normalizeName(k.String?.sval || ""));
          table.pk = cols;
          break;
        }
        case "CONSTR_UNIQUE": {
          const cols = (con.keys || []).map((k) => normalizeName(k.String?.sval || ""));
          table.uniqueConstraints.push({ name: con.conname, columns: cols });
          break;
        }
        case "CONSTR_FOREIGN": {
          addForeignKey(schema, tableName, table, con);
          break;
        }
      }
    }
  }
}
function addForeignKey(schema, tableName, table, con) {
  const refTable = formatRangeVar(con.pktable);
  const fkCols = (con.fk_attrs || []).map((a) => normalizeName(a.String?.sval || ""));
  const pkCols = (con.pk_attrs || []).map((a) => normalizeName(a.String?.sval || ""));
  const onDelete = con.fk_del_action ? fkActionName(con.fk_del_action) : void 0;
  table.fkOut.push({
    name: con.conname,
    columns: fkCols,
    refTable,
    refColumns: pkCols,
    onDelete
  });
  const refTableSchema = ensureTable(schema, refTable);
  refTableSchema.fkIn.push({
    name: con.conname,
    fromTable: normalizeName(tableName),
    fromColumns: fkCols,
    columns: pkCols
  });
}
function fkActionName(action) {
  switch (action) {
    case "FKCONSTR_ACTION_CASCADE":
      return "CASCADE";
    case "FKCONSTR_ACTION_SETNULL":
      return "SET NULL";
    case "FKCONSTR_ACTION_SETDEFAULT":
      return "SET DEFAULT";
    case "FKCONSTR_ACTION_RESTRICT":
      return "RESTRICT";
    case "FKCONSTR_ACTION_NOACTION":
      return "NO ACTION";
    default:
      return void 0;
  }
}
function applyAlterTable(schema, detail) {
  const tableName = formatRangeVar(detail.relation);
  for (const cmd of detail.cmds || []) {
    const at = cmd.AlterTableCmd;
    if (!at) continue;
    switch (at.subtype) {
      case "AT_AddColumn": {
        if (at.def?.ColumnDef) {
          const col = at.def.ColumnDef;
          const colName = normalizeName(col.colname);
          const colType = extractTypeName(col.typeName);
          const constraints = col.constraints || [];
          const nullable = !constraints.some((c) => c.Constraint?.contype === "CONSTR_NOTNULL");
          const hasDefault = constraints.some((c) => c.Constraint?.contype === "CONSTR_DEFAULT");
          const table = ensureTable(schema, tableName);
          table.columns.set(colName, { type: colType, nullable, hasDefault });
        }
        break;
      }
      case "AT_DropColumn": {
        const colName = normalizeName(at.name);
        const normTable = normalizeName(tableName);
        const table = schema.tables.get(normTable);
        if (table) {
          table.columns.delete(colName);
          if (table.pk) table.pk = table.pk.filter((c) => c !== colName);
          const removedFks = table.fkOut.filter((fk) => fk.columns.includes(colName));
          table.fkOut = table.fkOut.filter((fk) => !fk.columns.includes(colName));
          for (const fk of removedFks) {
            const refTable = schema.tables.get(normalizeName(fk.refTable));
            if (refTable) {
              refTable.fkIn = refTable.fkIn.filter(
                (r) => !(r.fromTable === normTable && r.fromColumns.some((c) => c === colName))
              );
            }
          }
          for (const fkIn of table.fkIn.filter((r) => r.columns.includes(colName))) {
            const fromTable = schema.tables.get(normalizeName(fkIn.fromTable));
            if (fromTable) {
              fromTable.fkOut = fromTable.fkOut.filter(
                (fk) => !(normalizeName(fk.refTable) === normTable && fk.refColumns.includes(colName))
              );
            }
          }
          table.fkIn = table.fkIn.filter((r) => !r.columns.includes(colName));
        }
        break;
      }
      case "AT_AlterColumnType": {
        const colName = normalizeName(at.name);
        const table = schema.tables.get(normalizeName(tableName));
        if (table) {
          const existing = table.columns.get(colName);
          if (existing && at.def?.ColumnDef?.typeName) {
            existing.type = extractTypeName(at.def.ColumnDef.typeName);
          }
        }
        break;
      }
      case "AT_SetNotNull": {
        const colName = normalizeName(at.name);
        const table = schema.tables.get(normalizeName(tableName));
        if (table) {
          const existing = table.columns.get(colName);
          if (existing) existing.nullable = false;
        }
        break;
      }
      case "AT_DropNotNull": {
        const colName = normalizeName(at.name);
        const table = schema.tables.get(normalizeName(tableName));
        if (table) {
          const existing = table.columns.get(colName);
          if (existing) existing.nullable = true;
        }
        break;
      }
      case "AT_ColumnDefault":
      case "AT_SetDefault": {
        const colName = normalizeName(at.name);
        const table = schema.tables.get(normalizeName(tableName));
        if (table) {
          const existing = table.columns.get(colName);
          if (existing) existing.hasDefault = true;
        }
        break;
      }
      case "AT_DropDefault": {
        const colName = normalizeName(at.name);
        const table = schema.tables.get(normalizeName(tableName));
        if (table) {
          const existing = table.columns.get(colName);
          if (existing) existing.hasDefault = false;
        }
        break;
      }
      case "AT_AddConstraint": {
        if (at.def?.Constraint) {
          const con = at.def.Constraint;
          const table = ensureTable(schema, tableName);
          switch (con.contype) {
            case "CONSTR_PRIMARY": {
              const cols = (con.keys || []).map((k) => normalizeName(k.String?.sval || ""));
              table.pk = cols;
              break;
            }
            case "CONSTR_UNIQUE": {
              const cols = (con.keys || []).map((k) => normalizeName(k.String?.sval || ""));
              table.uniqueConstraints.push({ name: con.conname, columns: cols });
              break;
            }
            case "CONSTR_FOREIGN": {
              addForeignKey(schema, tableName, table, con);
              break;
            }
          }
        }
        break;
      }
      case "AT_DropConstraint": {
        const conName = at.name;
        const normT = normalizeName(tableName);
        const table = schema.tables.get(normT);
        if (table && conName) {
          let removedFk = table.fkOut.find((fk) => fk.name === conName);
          if (!removedFk) {
            const fkeyMatch = conName.match(/^.+_(.+)_fkey$/i);
            if (fkeyMatch) {
              const colName = normalizeName(fkeyMatch[1]);
              removedFk = table.fkOut.find((fk) => !fk.name && fk.columns.length === 1 && fk.columns[0] === colName);
            }
          }
          if (removedFk) {
            table.fkOut = table.fkOut.filter((fk) => fk !== removedFk);
            const refTable = schema.tables.get(normalizeName(removedFk.refTable));
            if (refTable) {
              refTable.fkIn = refTable.fkIn.filter(
                (fk) => !(fk.fromTable === normT && fk.fromColumns.length === removedFk.columns.length && fk.fromColumns.every((c, i) => c === removedFk.columns[i]))
              );
            }
          } else {
            table.fkOut = table.fkOut.filter((fk) => fk.name !== conName);
          }
          table.uniqueConstraints = table.uniqueConstraints.filter((u) => u.name !== conName);
        }
        break;
      }
    }
  }
}
function applyDrop(schema, detail) {
  if (detail.removeType === "OBJECT_TABLE") {
    for (const obj of detail.objects || []) {
      const items = obj.List?.items || (Array.isArray(obj) ? obj : []);
      const name = items.map((n) => n.String?.sval || "?").join(".");
      const norm = normalizeName(name);
      const table = schema.tables.get(norm);
      if (table) {
        for (const fk of table.fkOut) {
          const refTable = schema.tables.get(normalizeName(fk.refTable));
          if (refTable) {
            refTable.fkIn = refTable.fkIn.filter((r) => r.fromTable !== norm);
          }
        }
        for (const fk of table.fkIn) {
          const fromTable = schema.tables.get(normalizeName(fk.fromTable));
          if (fromTable) {
            fromTable.fkOut = fromTable.fkOut.filter((f) => f.refTable !== norm);
          }
        }
        schema.tables.delete(norm);
      }
    }
  }
  if (detail.removeType === "OBJECT_INDEX") {
    for (const [, table] of schema.tables) {
      for (const obj of detail.objects || []) {
        const items = obj.List?.items || (Array.isArray(obj) ? obj : []);
        const idxName = items.map((n) => n.String?.sval || "?").join(".");
        table.indexes = table.indexes.filter((idx) => idx.name !== normalizeName(idxName));
      }
    }
  }
}
function applyRename(schema, detail) {
  const renameType = detail.renameType;
  if (renameType === "OBJECT_TABLE") {
    const oldName = formatRangeVar(detail.relation);
    const newName = normalizeName(detail.newname);
    const table = schema.tables.get(normalizeName(oldName));
    if (table) {
      schema.tables.delete(normalizeName(oldName));
      schema.tables.set(newName, table);
      for (const [, t] of schema.tables) {
        for (const fk of t.fkOut) {
          if (normalizeName(fk.refTable) === normalizeName(oldName)) fk.refTable = newName;
        }
        for (const fk of t.fkIn) {
          if (normalizeName(fk.fromTable) === normalizeName(oldName)) fk.fromTable = newName;
        }
      }
    }
  } else if (renameType === "OBJECT_COLUMN") {
    const tableName = formatRangeVar(detail.relation);
    const normTable = normalizeName(tableName);
    const oldCol = normalizeName(detail.subname);
    const newCol = normalizeName(detail.newname);
    const table = schema.tables.get(normTable);
    if (table) {
      const colDef = table.columns.get(oldCol);
      if (colDef) {
        table.columns.delete(oldCol);
        table.columns.set(newCol, colDef);
      }
      if (table.pk) table.pk = table.pk.map((c) => c === oldCol ? newCol : c);
      for (const fk of table.fkOut) {
        const changed = fk.columns.includes(oldCol);
        fk.columns = fk.columns.map((c) => c === oldCol ? newCol : c);
        if (changed) {
          const refTable = schema.tables.get(normalizeName(fk.refTable));
          if (refTable) {
            for (const fkIn of refTable.fkIn) {
              if (fkIn.fromTable === normTable) {
                fkIn.fromColumns = fkIn.fromColumns.map((c) => c === oldCol ? newCol : c);
              }
            }
          }
        }
      }
      for (const fkIn of table.fkIn) {
        const changed = fkIn.columns.includes(oldCol);
        fkIn.columns = fkIn.columns.map((c) => c === oldCol ? newCol : c);
        if (changed) {
          const fromTable = schema.tables.get(normalizeName(fkIn.fromTable));
          if (fromTable) {
            for (const fk of fromTable.fkOut) {
              if (normalizeName(fk.refTable) === normTable) {
                fk.refColumns = fk.refColumns.map((c) => c === oldCol ? newCol : c);
              }
            }
          }
        }
      }
      for (const u of table.uniqueConstraints) {
        u.columns = u.columns.map((c) => c === oldCol ? newCol : c);
      }
      for (const idx of table.indexes) {
        idx.columns = idx.columns.map((c) => c === oldCol ? newCol : c);
      }
    }
  }
}
function applyCreateIndex(schema, detail) {
  const tableName = formatRangeVar(detail.relation);
  const table = schema.tables.get(normalizeName(tableName));
  if (table) {
    const idxName = detail.idxname ? normalizeName(detail.idxname) : void 0;
    const cols = (detail.indexParams || []).map((p) => normalizeName(p.IndexElem?.name || "")).filter(Boolean);
    table.indexes.push({
      name: idxName,
      columns: cols,
      unique: !!detail.unique
    });
  }
}
function buildSchemaFromSQL(sqlFiles) {
  const schema = createEmptySchema();
  for (const sql of sqlFiles) {
    const ast = (0, import_libpg_query.parseSync)(sql);
    for (const s of ast.stmts || []) {
      applyStatement(schema, s.stmt);
    }
  }
  return schema;
}
function applyMigrationSQL(schema, sql) {
  const ast = (0, import_libpg_query.parseSync)(sql);
  for (const s of ast.stmts || []) {
    applyStatement(schema, s.stmt);
  }
}
function applyOp(schema, op) {
  const n = normalizeName;
  switch (op.op) {
    case "create_table": {
      const table = ensureTable(schema, op.table);
      for (const col of op.columns) {
        table.columns.set(n(col.name), { type: col.type, nullable: col.nullable, hasDefault: col.hasDefault });
      }
      for (const con of op.constraints) {
        if (con.type === "primary_key" && con.columns) table.pk = con.columns.map(n);
        if (con.type === "unique" && con.columns) table.uniqueConstraints.push({ name: con.name, columns: con.columns.map(n) });
        if (con.type === "foreign_key" && con.fk) {
          const fk = con.fk;
          table.fkOut.push({ name: con.name, columns: fk.columns.map(n), refTable: n(fk.refTable), refColumns: fk.refColumns.map(n), onDelete: fk.onDelete });
          const ref = ensureTable(schema, fk.refTable);
          ref.fkIn.push({ name: con.name, fromTable: n(op.table), fromColumns: fk.columns.map(n), columns: fk.refColumns.map(n) });
        }
      }
      break;
    }
    case "drop_table": {
      const normT = n(op.table);
      const table = schema.tables.get(normT);
      if (table) {
        for (const fk of table.fkOut) {
          const ref = schema.tables.get(n(fk.refTable));
          if (ref) ref.fkIn = ref.fkIn.filter((r) => r.fromTable !== normT);
        }
        for (const fk of table.fkIn) {
          const from = schema.tables.get(n(fk.fromTable));
          if (from) from.fkOut = from.fkOut.filter((f) => n(f.refTable) !== normT);
        }
        schema.tables.delete(normT);
      }
      break;
    }
    case "add_column": {
      const table = schema.tables.get(n(op.table));
      if (table) table.columns.set(n(op.column.name), { type: op.column.type, nullable: op.column.nullable, hasDefault: op.column.hasDefault });
      break;
    }
    case "drop_column": {
      const normT = n(op.table);
      const table = schema.tables.get(normT);
      if (table) {
        const colN = n(op.column);
        table.columns.delete(colN);
        if (table.pk) table.pk = table.pk.filter((c) => c !== colN);
        const removedFks = table.fkOut.filter((fk) => fk.columns.includes(colN));
        table.fkOut = table.fkOut.filter((fk) => !fk.columns.includes(colN));
        for (const fk of removedFks) {
          const ref = schema.tables.get(n(fk.refTable));
          if (ref) ref.fkIn = ref.fkIn.filter((r) => !(r.fromTable === normT && r.fromColumns.some((c) => c === colN)));
        }
        for (const fkIn of table.fkIn.filter((r) => r.columns.includes(colN))) {
          const from = schema.tables.get(n(fkIn.fromTable));
          if (from) from.fkOut = from.fkOut.filter((fk) => !(n(fk.refTable) === normT && fk.refColumns.includes(colN)));
        }
        table.fkIn = table.fkIn.filter((r) => !r.columns.includes(colN));
      }
      break;
    }
    case "add_constraint": {
      const table = schema.tables.get(n(op.table));
      if (table && op.constraint.type === "foreign_key" && op.constraint.fk) {
        const fk = op.constraint.fk;
        table.fkOut.push({ name: op.constraint.name, columns: fk.columns.map(n), refTable: n(fk.refTable), refColumns: fk.refColumns.map(n), onDelete: fk.onDelete });
        const ref = ensureTable(schema, fk.refTable);
        ref.fkIn.push({ name: op.constraint.name, fromTable: n(op.table), fromColumns: fk.columns.map(n), columns: fk.refColumns.map(n) });
      }
      if (table && op.constraint.type === "primary_key" && op.constraint.columns) {
        table.pk = op.constraint.columns.map(n);
      }
      if (table && op.constraint.type === "unique" && op.constraint.columns) {
        table.uniqueConstraints.push({ name: op.constraint.name, columns: op.constraint.columns.map(n) });
      }
      break;
    }
    case "drop_constraint": {
      const normT = n(op.table);
      const table = schema.tables.get(normT);
      if (table) {
        let removed = table.fkOut.find((fk) => fk.name === op.name);
        if (!removed) {
          const fkeyMatch = op.name.match(/^.+_(.+)_fkey$/i);
          if (fkeyMatch) {
            const colName = n(fkeyMatch[1]);
            removed = table.fkOut.find((fk) => !fk.name && fk.columns.length === 1 && fk.columns[0] === colName);
          }
        }
        if (removed) {
          table.fkOut = table.fkOut.filter((fk) => fk !== removed);
          const ref = schema.tables.get(n(removed.refTable));
          if (ref) {
            ref.fkIn = ref.fkIn.filter(
              (fk) => !(fk.fromTable === normT && fk.fromColumns.length === removed.columns.length && fk.fromColumns.every((c, i) => c === removed.columns[i]))
            );
          }
        } else {
          table.fkOut = table.fkOut.filter((fk) => fk.name !== op.name);
        }
        table.uniqueConstraints = table.uniqueConstraints.filter((u) => u.name !== op.name);
      }
      break;
    }
    case "rename_table": {
      const oldN = n(op.table);
      const newN = n(op.newName);
      const table = schema.tables.get(oldN);
      if (table) {
        schema.tables.delete(oldN);
        schema.tables.set(newN, table);
        for (const [, t] of schema.tables) {
          for (const fk of t.fkOut) {
            if (n(fk.refTable) === oldN) fk.refTable = newN;
          }
          for (const fk of t.fkIn) {
            if (n(fk.fromTable) === oldN) fk.fromTable = newN;
          }
        }
      }
      break;
    }
    case "rename_column": {
      const table = schema.tables.get(n(op.table));
      if (table) {
        const oldC = n(op.column), newC = n(op.newName);
        const colDef = table.columns.get(oldC);
        if (colDef) {
          table.columns.delete(oldC);
          table.columns.set(newC, colDef);
        }
        if (table.pk) table.pk = table.pk.map((c) => c === oldC ? newC : c);
        for (const fk of table.fkOut) fk.columns = fk.columns.map((c) => c === oldC ? newC : c);
        for (const fkIn of table.fkIn) fkIn.columns = fkIn.columns.map((c) => c === oldC ? newC : c);
      }
      break;
    }
    case "alter_column_type": {
      const table = schema.tables.get(n(op.table));
      if (table) {
        const col = table.columns.get(n(op.column));
        if (col) col.type = op.newType;
      }
      break;
    }
    case "alter_column_set_not_null": {
      const table = schema.tables.get(n(op.table));
      if (table) {
        const col = table.columns.get(n(op.column));
        if (col) col.nullable = false;
      }
      break;
    }
    case "alter_column_drop_not_null": {
      const table = schema.tables.get(n(op.table));
      if (table) {
        const col = table.columns.get(n(op.column));
        if (col) col.nullable = true;
      }
      break;
    }
    case "alter_column_set_default": {
      const table = schema.tables.get(n(op.table));
      if (table) {
        const col = table.columns.get(n(op.column));
        if (col) col.hasDefault = true;
      }
      break;
    }
    case "alter_column_drop_default": {
      const table = schema.tables.get(n(op.table));
      if (table) {
        const col = table.columns.get(n(op.column));
        if (col) col.hasDefault = false;
      }
      break;
    }
    case "create_index": {
      const table = schema.tables.get(n(op.table));
      if (table) table.indexes.push({ name: op.name ? n(op.name) : void 0, columns: op.columns.map(n), unique: !!op.unique });
      break;
    }
  }
}
function printSchema(schema) {
  for (const [tableName, table] of schema.tables) {
    console.log(`
TABLE: ${tableName}`);
    if (table.pk) console.log(`  PK: (${table.pk.join(", ")})`);
    for (const [colName, col] of table.columns) {
      const flags = [
        col.nullable ? "NULL" : "NOT NULL",
        col.hasDefault ? "DEFAULT" : ""
      ].filter(Boolean).join(" ");
      console.log(`  ${colName}: ${col.type} [${flags}]`);
    }
    for (const u of table.uniqueConstraints) {
      console.log(`  UNIQUE${u.name ? ` ${u.name}` : ""}: (${u.columns.join(", ")})`);
    }
    for (const fk of table.fkOut) {
      console.log(`  FK OUT${fk.name ? ` ${fk.name}` : ""}: (${fk.columns.join(", ")}) -> ${fk.refTable}(${fk.refColumns.join(", ")})${fk.onDelete ? ` ON DELETE ${fk.onDelete}` : ""}`);
    }
    for (const fk of table.fkIn) {
      console.log(`  FK IN${fk.name ? ` ${fk.name}` : ""}: ${fk.fromTable}(${fk.fromColumns.join(", ")}) -> (${fk.columns.join(", ")})`);
    }
    for (const idx of table.indexes) {
      console.log(`  INDEX${idx.name ? ` ${idx.name}` : ""}: (${idx.columns.join(", ")})${idx.unique ? " UNIQUE" : ""}`);
    }
  }
}
var import_libpg_query;
var init_schema_loader = __esm({
  "scripts/mvp-migration/schema-loader.ts"() {
    "use strict";
    import_libpg_query = __toESM(require_wasm(), 1);
  }
});

// scripts/mvp-migration/spec-from-ast.ts
var spec_from_ast_exports = {};
__export(spec_from_ast_exports, {
  parseMigration: () => parseMigration
});
function formatRangeVar2(rel) {
  if (!rel) return "(unknown)";
  const schema = rel.schemaname ? `${rel.schemaname}.` : "";
  return normalizeName(`${schema}${rel.relname}`);
}
function extractTypeName2(tn) {
  if (!tn) return "unknown";
  const names = (tn.TypeName?.names || tn.names || []).map((n) => n.String?.sval || "?").filter((n) => n !== "pg_catalog");
  return names.join(".") || "unknown";
}
function extractColumnDef(colAst) {
  const constraints = colAst.constraints || [];
  return {
    name: normalizeName(colAst.colname),
    type: extractTypeName2(colAst.typeName),
    nullable: !constraints.some((c) => c.Constraint?.contype === "CONSTR_NOTNULL"),
    hasDefault: constraints.some((c) => c.Constraint?.contype === "CONSTR_DEFAULT"),
    identity: constraints.some((c) => c.Constraint?.contype === "CONSTR_IDENTITY")
  };
}
function extractForeignKey(con) {
  return {
    columns: (con.fk_attrs || []).map((a) => normalizeName(a.String?.sval || "")),
    refTable: formatRangeVar2(con.pktable),
    refColumns: (con.pk_attrs || []).map((a) => normalizeName(a.String?.sval || "")),
    onDelete: con.fk_del_action ? fkActionName2(con.fk_del_action) : void 0,
    onUpdate: con.fk_upd_action ? fkActionName2(con.fk_upd_action) : void 0
  };
}
function fkActionName2(action) {
  switch (action) {
    case "FKCONSTR_ACTION_CASCADE":
      return "CASCADE";
    case "FKCONSTR_ACTION_SETNULL":
      return "SET NULL";
    case "FKCONSTR_ACTION_SETDEFAULT":
      return "SET DEFAULT";
    case "FKCONSTR_ACTION_RESTRICT":
      return "RESTRICT";
    case "FKCONSTR_ACTION_NOACTION":
      return "NO ACTION";
    default:
      return void 0;
  }
}
function extractConstraint(con) {
  switch (con.contype) {
    case "CONSTR_PRIMARY": {
      const cols = (con.keys || []).map((k) => normalizeName(k.String?.sval || ""));
      return { type: "primary_key", name: con.conname, columns: cols };
    }
    case "CONSTR_UNIQUE": {
      const cols = (con.keys || []).map((k) => normalizeName(k.String?.sval || ""));
      return { type: "unique", name: con.conname, columns: cols };
    }
    case "CONSTR_FOREIGN": {
      return { type: "foreign_key", name: con.conname, fk: extractForeignKey(con) };
    }
    case "CONSTR_CHECK": {
      return { type: "check", name: con.conname };
    }
    case "CONSTR_EXCLUSION": {
      return { type: "exclusion", name: con.conname };
    }
    default:
      return null;
  }
}
function translateCreateStmt(detail) {
  const tableName = formatRangeVar2(detail.relation);
  const columns = [];
  const constraints = [];
  for (const elt of detail.tableElts || []) {
    if (elt.ColumnDef) {
      columns.push(extractColumnDef(elt.ColumnDef));
      for (const c of elt.ColumnDef.constraints || []) {
        if (c.Constraint) {
          const con = extractConstraint(c.Constraint);
          if (con) constraints.push(con);
        }
      }
    }
    if (elt.Constraint) {
      const con = extractConstraint(elt.Constraint);
      if (con) constraints.push(con);
    }
  }
  let partitionBy;
  if (detail.partspec) {
    partitionBy = detail.partspec.strategy || "unknown";
  }
  return {
    op: "create_table",
    table: tableName,
    columns,
    constraints,
    partitionBy,
    ifNotExists: !!detail.if_not_exists
  };
}
function translateAlterTableStmt(detail) {
  const tableName = formatRangeVar2(detail.relation);
  const ops = [];
  for (const cmd of detail.cmds || []) {
    const at = cmd.AlterTableCmd;
    if (!at) continue;
    switch (at.subtype) {
      case "AT_AddColumn": {
        if (at.def?.ColumnDef) {
          ops.push({
            op: "add_column",
            table: tableName,
            column: extractColumnDef(at.def.ColumnDef)
          });
        }
        break;
      }
      case "AT_DropColumn": {
        ops.push({
          op: "drop_column",
          table: tableName,
          column: normalizeName(at.name),
          cascade: at.behavior === "DROP_CASCADE"
        });
        break;
      }
      case "AT_AlterColumnType": {
        const newType = at.def?.ColumnDef?.typeName ? extractTypeName2(at.def.ColumnDef.typeName) : "unknown";
        ops.push({
          op: "alter_column_type",
          table: tableName,
          column: normalizeName(at.name),
          newType
        });
        break;
      }
      case "AT_SetNotNull": {
        ops.push({
          op: "alter_column_set_not_null",
          table: tableName,
          column: normalizeName(at.name)
        });
        break;
      }
      case "AT_DropNotNull": {
        ops.push({
          op: "alter_column_drop_not_null",
          table: tableName,
          column: normalizeName(at.name)
        });
        break;
      }
      case "AT_ColumnDefault":
      case "AT_SetDefault": {
        ops.push({
          op: "alter_column_set_default",
          table: tableName,
          column: normalizeName(at.name),
          expr: "(expression)"
          // TODO: deparse the default expression
        });
        break;
      }
      case "AT_DropDefault": {
        ops.push({
          op: "alter_column_drop_default",
          table: tableName,
          column: normalizeName(at.name)
        });
        break;
      }
      case "AT_AddConstraint": {
        if (at.def?.Constraint) {
          const con = extractConstraint(at.def.Constraint);
          if (con) {
            ops.push({ op: "add_constraint", table: tableName, constraint: con });
          }
        }
        break;
      }
      case "AT_DropConstraint": {
        ops.push({
          op: "drop_constraint",
          table: tableName,
          name: at.name || "(unnamed)",
          cascade: at.behavior === "DROP_CASCADE"
        });
        break;
      }
      default: {
        ops.push({ op: "unsupported", stmtType: `AlterTableCmd:${at.subtype}` });
      }
    }
  }
  return ops;
}
function translateDropStmt(detail) {
  const ops = [];
  const cascade = detail.behavior === "DROP_CASCADE";
  const ifExists = !!detail.missing_ok;
  if (detail.removeType === "OBJECT_TABLE") {
    for (const obj of detail.objects || []) {
      const items = obj.List?.items || (Array.isArray(obj) ? obj : []);
      const name = normalizeName(items.map((n) => n.String?.sval || "?").join("."));
      ops.push({ op: "drop_table", table: name, cascade, ifExists });
    }
  } else if (detail.removeType === "OBJECT_INDEX") {
    for (const obj of detail.objects || []) {
      const items = obj.List?.items || (Array.isArray(obj) ? obj : []);
      const name = normalizeName(items.map((n) => n.String?.sval || "?").join("."));
      ops.push({ op: "drop_index", name, cascade });
    }
  } else {
    ops.push({ op: "unsupported", stmtType: `DropStmt:${detail.removeType}` });
  }
  return ops;
}
function translateRenameStmt(detail) {
  if (detail.renameType === "OBJECT_TABLE") {
    return {
      op: "rename_table",
      table: formatRangeVar2(detail.relation),
      newName: normalizeName(detail.newname)
    };
  } else if (detail.renameType === "OBJECT_COLUMN") {
    return {
      op: "rename_column",
      table: formatRangeVar2(detail.relation),
      column: normalizeName(detail.subname),
      newName: normalizeName(detail.newname)
    };
  }
  return { op: "unsupported", stmtType: `RenameStmt:${detail.renameType}` };
}
function translateIndexStmt(detail) {
  return {
    op: "create_index",
    table: formatRangeVar2(detail.relation),
    name: detail.idxname ? normalizeName(detail.idxname) : void 0,
    columns: (detail.indexParams || []).map((p) => normalizeName(p.IndexElem?.name || "")).filter(Boolean),
    unique: !!detail.unique
  };
}
function translateSimple(stmtType, detail) {
  switch (stmtType) {
    case "CreateSchemaStmt":
      return { op: "create_schema", name: normalizeName(detail.schemaname || "") };
    case "CreateExtensionStmt":
      return { op: "create_extension", name: detail.extname || "" };
    case "CreateFunctionStmt": {
      const fname = (detail.funcname || []).map((n) => n.String?.sval || "?").join(".");
      return { op: "create_function", name: fname };
    }
    default:
      return { op: "unsupported", stmtType };
  }
}
function byteOffsetToLine(sql, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < sql.length; i++) {
    if (sql[i] === "\n") line++;
  }
  return line;
}
function parseMigration(sql, file) {
  const operations = [];
  const parseErrors = [];
  let totalStatements = 0;
  let supportedStatements = 0;
  let opIndex = 0;
  let ast;
  try {
    ast = (0, import_libpg_query2.parseSync)(sql);
  } catch (err) {
    parseErrors.push(err.message);
    return {
      file,
      operations: [],
      raw: sql,
      meta: { totalStatements: 0, supportedStatements: 0, unsupportedStatements: 0, parseErrors }
    };
  }
  function addOps(stmtIndex, line, ops) {
    for (const op of ops) {
      operations.push({ opIndex: opIndex++, stmtIndex, line, op });
    }
  }
  for (let si = 0; si < (ast.stmts || []).length; si++) {
    const s = ast.stmts[si];
    totalStatements++;
    const stmt = s.stmt;
    const stmtType = Object.keys(stmt)[0];
    const detail = stmt[stmtType];
    const line = byteOffsetToLine(sql, s.stmt_location || 0);
    switch (stmtType) {
      case "CreateStmt": {
        addOps(si, line, [translateCreateStmt(detail)]);
        supportedStatements++;
        break;
      }
      case "AlterTableStmt": {
        addOps(si, line, translateAlterTableStmt(detail));
        supportedStatements++;
        break;
      }
      case "DropStmt": {
        addOps(si, line, translateDropStmt(detail));
        supportedStatements++;
        break;
      }
      case "RenameStmt": {
        addOps(si, line, [translateRenameStmt(detail)]);
        supportedStatements++;
        break;
      }
      case "IndexStmt": {
        addOps(si, line, [translateIndexStmt(detail)]);
        supportedStatements++;
        break;
      }
      case "CreateSchemaStmt":
      case "CreateExtensionStmt":
      case "CreateFunctionStmt": {
        addOps(si, line, [translateSimple(stmtType, detail)]);
        supportedStatements++;
        break;
      }
      default: {
        addOps(si, line, [{ op: "unsupported", stmtType }]);
      }
    }
  }
  return {
    file,
    operations,
    raw: sql,
    meta: {
      totalStatements,
      supportedStatements,
      unsupportedStatements: totalStatements - supportedStatements,
      parseErrors
    }
  };
}
var import_libpg_query2;
var init_spec_from_ast = __esm({
  "scripts/mvp-migration/spec-from-ast.ts"() {
    "use strict";
    import_libpg_query2 = __toESM(require_wasm(), 1);
    init_schema_loader();
  }
});

// scripts/mvp-migration/grounding-gate.ts
var grounding_gate_exports = {};
__export(grounding_gate_exports, {
  runGroundingGate: () => runGroundingGate
});
function isPlatformTable(tableName) {
  const norm = normalizeName(tableName);
  return PLATFORM_SCHEMA_PREFIXES.some((prefix) => norm.startsWith(prefix));
}
function runGroundingGate(spec, schema) {
  const findings = [];
  const workingSchema = cloneSchema(schema);
  for (const located of spec.operations) {
    const loc = { stmtIndex: located.stmtIndex, opIndex: located.opIndex, line: located.line };
    for (const f of checkOp(located.op, workingSchema)) {
      f.location = loc;
      findings.push(f);
    }
    try {
      applyOp(workingSchema, located.op);
    } catch {
    }
  }
  return findings;
}
function cloneSchema(schema) {
  const clone = { tables: /* @__PURE__ */ new Map() };
  for (const [name, table] of schema.tables) {
    clone.tables.set(name, {
      columns: new Map(table.columns),
      pk: table.pk ? [...table.pk] : void 0,
      uniqueConstraints: table.uniqueConstraints.map((u) => ({ ...u, columns: [...u.columns] })),
      fkOut: table.fkOut.map((fk) => ({ ...fk, columns: [...fk.columns], refColumns: [...fk.refColumns] })),
      fkIn: table.fkIn.map((fk) => ({ ...fk, fromColumns: [...fk.fromColumns], columns: [...fk.columns] })),
      indexes: table.indexes.map((idx) => ({ ...idx, columns: [...idx.columns] }))
    });
  }
  return clone;
}
function checkOp(op, schema) {
  switch (op.op) {
    case "create_table":
      return checkCreateTable(op, schema);
    case "drop_table":
      return checkDropTable(op, schema);
    case "add_column":
      return checkAddColumn(op, schema);
    case "drop_column":
      return checkDropColumn(op, schema);
    case "alter_column_type":
      return checkAlterColumnType(op, schema);
    case "alter_column_set_not_null":
      return checkColumnExists(op, schema, op.table, op.column);
    case "alter_column_drop_not_null":
      return checkColumnExists(op, schema, op.table, op.column);
    case "alter_column_set_default":
      return checkColumnExists(op, schema, op.table, op.column);
    case "alter_column_drop_default":
      return checkColumnExists(op, schema, op.table, op.column);
    case "add_constraint":
      return checkAddConstraint(op, schema);
    case "drop_constraint":
      return checkDropConstraint(op, schema);
    case "create_index":
      return checkCreateIndex(op, schema);
    case "drop_index":
      return checkDropIndex(op, schema);
    case "rename_table":
      return checkRenameTable(op, schema);
    case "rename_column":
      return checkRenameColumn(op, schema);
    default:
      return [];
  }
}
function tableExists(schema, name) {
  return schema.tables.has(normalizeName(name));
}
function columnExists(schema, table, column) {
  const t = schema.tables.get(normalizeName(table));
  return t ? t.columns.has(normalizeName(column)) : false;
}
function findClosestTable(schema, name) {
  const norm = normalizeName(name);
  let best;
  let bestDist = Infinity;
  for (const key of schema.tables.keys()) {
    const d = levenshtein(norm, key);
    if (d < bestDist && d <= 3) {
      bestDist = d;
      best = key;
    }
  }
  return best;
}
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}
function finding(shapeId, message, op, severity = "error") {
  return { shapeId, message, operation: op, severity };
}
function checkCreateTable(op, schema) {
  const findings = [];
  if (op.ifNotExists) return findings;
  if (tableExists(schema, op.table)) {
    findings.push(finding("DM-04", `CREATE TABLE ${op.table}: table already exists`, op));
  }
  for (const con of op.constraints) {
    if (con.type === "foreign_key" && con.fk) {
      findings.push(...checkFkTarget(op, con.fk, schema));
    }
  }
  return findings;
}
function checkDropTable(op, schema) {
  const findings = [];
  if (op.ifExists) return findings;
  if (!tableExists(schema, op.table)) {
    const closest = findClosestTable(schema, op.table);
    const hint = closest ? ` Closest match: '${closest}'.` : "";
    findings.push(finding("DM-01", `DROP TABLE ${op.table}: table not found in schema.${hint}`, op));
  }
  return findings;
}
function checkAddColumn(op, schema) {
  const findings = [];
  if (!tableExists(schema, op.table)) {
    const closest = findClosestTable(schema, op.table);
    const hint = closest ? ` Closest match: '${closest}'.` : "";
    findings.push(finding("DM-01", `ADD COLUMN to ${op.table}: table not found.${hint}`, op));
    return findings;
  }
  if (columnExists(schema, op.table, op.column.name)) {
    findings.push(finding("DM-04", `ADD COLUMN ${op.table}.${op.column.name}: column already exists`, op));
  }
  return findings;
}
function checkDropColumn(op, schema) {
  const findings = [];
  if (!tableExists(schema, op.table)) {
    findings.push(finding("DM-01", `DROP COLUMN on ${op.table}: table not found`, op));
    return findings;
  }
  if (!columnExists(schema, op.table, op.column)) {
    findings.push(finding("DM-02", `DROP COLUMN ${op.table}.${op.column}: column not found`, op));
  }
  return findings;
}
function checkAlterColumnType(op, schema) {
  return checkColumnExists(op, schema, op.table, op.column);
}
function checkColumnExists(op, schema, table, column) {
  const findings = [];
  if (!tableExists(schema, table)) {
    findings.push(finding("DM-01", `${op.op} on ${table}: table not found`, op));
    return findings;
  }
  if (!columnExists(schema, table, column)) {
    findings.push(finding("DM-02", `${op.op} ${table}.${column}: column not found`, op));
  }
  return findings;
}
function checkAddConstraint(op, schema) {
  const findings = [];
  if (!tableExists(schema, op.table)) {
    findings.push(finding("DM-01", `ADD CONSTRAINT on ${op.table}: table not found`, op));
    return findings;
  }
  if (op.constraint.type === "foreign_key" && op.constraint.fk) {
    findings.push(...checkFkTarget(op, op.constraint.fk, schema));
  }
  if (op.constraint.columns) {
    for (const col of op.constraint.columns) {
      if (!columnExists(schema, op.table, col)) {
        findings.push(finding("DM-02", `ADD CONSTRAINT on ${op.table}: column '${col}' not found`, op));
      }
    }
  }
  return findings;
}
function checkDropConstraint(op, schema) {
  const findings = [];
  if (!tableExists(schema, op.table)) {
    findings.push(finding("DM-01", `DROP CONSTRAINT on ${op.table}: table not found`, op));
  }
  return findings;
}
function checkCreateIndex(op, schema) {
  const findings = [];
  if (!tableExists(schema, op.table)) {
    findings.push(finding("DM-01", `CREATE INDEX on ${op.table}: table not found`, op));
    return findings;
  }
  for (const col of op.columns) {
    if (!columnExists(schema, op.table, col)) {
      findings.push(finding("DM-02", `CREATE INDEX on ${op.table}: column '${col}' not found`, op));
    }
  }
  return findings;
}
function checkDropIndex(op, schema) {
  return [];
}
function checkRenameTable(op, schema) {
  const findings = [];
  if (!tableExists(schema, op.table)) {
    findings.push(finding("DM-05", `RENAME TABLE ${op.table}: source table not found`, op));
  }
  if (tableExists(schema, op.newName)) {
    findings.push(finding("DM-05", `RENAME TABLE ${op.table} TO ${op.newName}: target already exists`, op));
  }
  return findings;
}
function checkRenameColumn(op, schema) {
  const findings = [];
  if (!tableExists(schema, op.table)) {
    findings.push(finding("DM-01", `RENAME COLUMN on ${op.table}: table not found`, op));
    return findings;
  }
  if (!columnExists(schema, op.table, op.column)) {
    findings.push(finding("DM-02", `RENAME COLUMN ${op.table}.${op.column}: source column not found`, op));
  }
  if (columnExists(schema, op.table, op.newName)) {
    findings.push(finding("DM-05", `RENAME COLUMN ${op.table}.${op.column} TO ${op.newName}: target already exists`, op));
  }
  return findings;
}
function checkFkTarget(op, fk, schema) {
  const findings = [];
  if (isPlatformTable(fk.refTable)) return findings;
  if (!tableExists(schema, fk.refTable)) {
    const closest = findClosestTable(schema, fk.refTable);
    const hint = closest ? ` Closest match: '${closest}'.` : "";
    findings.push(finding(
      "DM-03",
      `FK references table '${fk.refTable}' which does not exist.${hint}`,
      op
    ));
    return findings;
  }
  for (const col of fk.refColumns) {
    if (!columnExists(schema, fk.refTable, col)) {
      findings.push(finding(
        "DM-03",
        `FK references column '${fk.refTable}.${col}' which does not exist`,
        op
      ));
    }
  }
  return findings;
}
var PLATFORM_SCHEMA_PREFIXES;
var init_grounding_gate = __esm({
  "scripts/mvp-migration/grounding-gate.ts"() {
    "use strict";
    init_schema_loader();
    PLATFORM_SCHEMA_PREFIXES = [
      "auth.",
      // Supabase Auth
      "storage.",
      // Supabase Storage
      "realtime.",
      // Supabase Realtime
      "extensions.",
      // Supabase Extensions
      "pgbouncer.",
      // PgBouncer
      "pg_catalog.",
      // Postgres system catalog
      "information_schema."
      // Postgres info schema
    ];
  }
});

// scripts/mvp-migration/safety-gate.ts
var safety_gate_exports = {};
__export(safety_gate_exports, {
  runSafetyGate: () => runSafetyGate
});
function isNarrowing(fromType, toType) {
  const from = fromType.toLowerCase();
  const to = toType.toLowerCase();
  return NARROWING_PAIRS.some(([f, t]) => from === f && to === t);
}
function parseAcks(sql) {
  const acks = /* @__PURE__ */ new Set();
  const pattern = /--\s*verify:\s*ack\s+(DM-\d+)/gi;
  let match;
  while ((match = pattern.exec(sql)) !== null) {
    acks.add(match[1].toUpperCase());
  }
  return acks;
}
function runSafetyGate(spec, schema) {
  const acks = parseAcks(spec.raw);
  const allFindings = [];
  const workingSchema = cloneSchema2(schema);
  for (const located of spec.operations) {
    const loc = { stmtIndex: located.stmtIndex, opIndex: located.opIndex, line: located.line };
    const findings = checkSafety(located.op, workingSchema);
    for (const f of findings) {
      f.location = loc;
      if (acks.has(f.shapeId)) {
        f.severity = "warning";
        f.message += " [ACKED]";
      }
      allFindings.push(f);
    }
    try {
      applyOp(workingSchema, located.op);
    } catch {
    }
  }
  return allFindings;
}
function cloneSchema2(schema) {
  const clone = { tables: /* @__PURE__ */ new Map() };
  for (const [name, table] of schema.tables) {
    clone.tables.set(name, {
      columns: new Map(table.columns),
      pk: table.pk ? [...table.pk] : void 0,
      uniqueConstraints: table.uniqueConstraints.map((u) => ({ ...u, columns: [...u.columns] })),
      fkOut: table.fkOut.map((fk) => ({ ...fk, columns: [...fk.columns], refColumns: [...fk.refColumns] })),
      fkIn: table.fkIn.map((fk) => ({ ...fk, fromColumns: [...fk.fromColumns], columns: [...fk.columns] })),
      indexes: table.indexes.map((idx) => ({ ...idx, columns: [...idx.columns] }))
    });
  }
  return clone;
}
function finding2(shapeId, message, op, severity = "error") {
  return {
    shapeId,
    message,
    operation: op,
    severity,
    ackPattern: `-- verify: ack ${shapeId} <reason>`
  };
}
function checkSafety(op, schema) {
  switch (op.op) {
    case "drop_column":
      return checkDropColumnSafety(op, schema);
    case "drop_table":
      return checkDropTableSafety(op, schema);
    case "alter_column_type":
      return checkAlterTypeSafety(op, schema);
    case "alter_column_set_not_null":
      return checkSetNotNullSafety(op, schema);
    case "add_column":
      return checkAddColumnNotNull(op, schema);
    case "drop_index":
      return checkDropIndexSafety(op, schema);
    default:
      return [];
  }
}
function checkDropColumnSafety(op, schema) {
  const findings = [];
  const table = schema.tables.get(normalizeName(op.table));
  if (!table) return findings;
  const colNorm = normalizeName(op.column);
  const dependents = table.fkIn.filter((fk) => fk.columns.includes(colNorm));
  if (dependents.length > 0) {
    const refs = dependents.map((fk) => `${fk.fromTable}(${fk.fromColumns.join(", ")})`).join(", ");
    findings.push(finding2(
      "DM-15",
      `DROP COLUMN ${op.table}.${op.column} has ${dependents.length} incoming FK reference(s): [${refs}]. DROP will cascade or fail at runtime.`,
      op
    ));
  }
  const outgoing = table.fkOut.filter((fk) => fk.columns.includes(colNorm));
  if (outgoing.length > 0 && !op.cascade) {
    const refs = outgoing.map((fk) => `-> ${fk.refTable}(${fk.refColumns.join(", ")})`).join(", ");
    findings.push(finding2(
      "DM-15",
      `DROP COLUMN ${op.table}.${op.column} is part of outgoing FK [${refs}] but CASCADE not specified. The constraint must be dropped first or CASCADE used.`,
      op,
      "warning"
    ));
  }
  return findings;
}
function checkDropTableSafety(op, schema) {
  const findings = [];
  const table = schema.tables.get(normalizeName(op.table));
  if (!table) return findings;
  if (table.fkIn.length > 0 && !op.cascade) {
    const refs = table.fkIn.map((fk) => `${fk.fromTable}(${fk.fromColumns.join(", ")})`).join(", ");
    findings.push(finding2(
      "DM-16",
      `DROP TABLE ${op.table} has ${table.fkIn.length} incoming FK reference(s): [${refs}]. DROP will fail without CASCADE or prior constraint removal.`,
      op
    ));
  }
  return findings;
}
function checkAlterTypeSafety(op, schema) {
  const findings = [];
  const table = schema.tables.get(normalizeName(op.table));
  if (!table) return findings;
  const col = table.columns.get(normalizeName(op.column));
  if (!col) return findings;
  if (isNarrowing(col.type, op.newType)) {
    findings.push(finding2(
      "DM-17",
      `ALTER COLUMN ${op.table}.${op.column} TYPE ${col.type} \u2192 ${op.newType}: narrowing conversion may cause silent data loss.`,
      op
    ));
  }
  const colNorm = normalizeName(op.column);
  const dependents = table.fkIn.filter((fk) => fk.columns.includes(colNorm));
  if (dependents.length > 0) {
    const refs = dependents.map((fk) => `${fk.fromTable}(${fk.fromColumns.join(", ")})`).join(", ");
    findings.push(finding2(
      "DM-17",
      `ALTER COLUMN TYPE on ${op.table}.${op.column}: column has ${dependents.length} incoming FK reference(s) [${refs}]. Type change may break referencing columns.`,
      op,
      "warning"
    ));
  }
  return findings;
}
function checkSetNotNullSafety(op, schema) {
  const findings = [];
  const table = schema.tables.get(normalizeName(op.table));
  if (!table) return findings;
  const col = table.columns.get(normalizeName(op.column));
  if (!col) return findings;
  if (col.nullable && !col.hasDefault) {
    findings.push(finding2(
      "DM-18",
      `SET NOT NULL on ${op.table}.${op.column}: column is currently nullable with no default. Will fail if any existing rows contain NULL.`,
      op,
      "warning"
    ));
  }
  return findings;
}
function checkAddColumnNotNull(op, schema) {
  const findings = [];
  if (!op.column.nullable && !op.column.hasDefault && !op.column.identity) {
    findings.push(finding2(
      "DM-18",
      `ADD COLUMN ${op.table}.${op.column.name} NOT NULL without DEFAULT. Will fail on any non-empty table.`,
      op
    ));
  }
  return findings;
}
function checkDropIndexSafety(op, schema) {
  const findings = [];
  const idxNorm = normalizeName(op.name);
  for (const [tableName, table] of schema.tables) {
    if (table.pk && idxNorm === `${tableName}_pkey`) {
      findings.push(finding2(
        "DM-19",
        `DROP INDEX ${op.name}: backs PRIMARY KEY on ${tableName}(${table.pk.join(", ")})`,
        op
      ));
    }
    for (const u of table.uniqueConstraints) {
      if (u.name && normalizeName(u.name) === idxNorm) {
        findings.push(finding2(
          "DM-19",
          `DROP INDEX ${op.name}: backs UNIQUE constraint on ${tableName}(${u.columns.join(", ")})`,
          op
        ));
      }
    }
  }
  return findings;
}
var NARROWING_PAIRS;
var init_safety_gate = __esm({
  "scripts/mvp-migration/safety-gate.ts"() {
    "use strict";
    init_schema_loader();
    NARROWING_PAIRS = [
      ["text", "varchar"],
      ["varchar", "char"],
      ["int8", "int4"],
      ["int8", "int2"],
      ["int4", "int2"],
      ["float8", "float4"],
      ["numeric", "int4"],
      ["numeric", "int8"],
      ["numeric", "float4"],
      ["timestamptz", "timestamp"],
      ["timestamptz", "date"],
      ["timestamp", "date"],
      ["text", "int4"],
      ["text", "int8"],
      ["text", "bool"],
      ["jsonb", "json"],
      ["json", "text"]
      // loses structure
    ];
  }
});

// src/action/index.ts
var index_exports = {};
__export(index_exports, {
  callLLM: () => callLLM
});
module.exports = __toCommonJS(index_exports);

// src/parsers/git-diff.ts
function parseDiff(diff) {
  const files = parseDiffFiles(diff);
  const edits = [];
  for (const file of files) {
    if (file.isBinary) continue;
    const filePath = file.newPath ?? file.oldPath;
    if (!filePath) continue;
    if (file.isNew) {
      const content = file.hunks.flatMap((h) => h.lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1))).join("\n");
      edits.push({
        file: filePath,
        search: "",
        replace: content
      });
      continue;
    }
    if (file.isDeleted) {
      const content = file.hunks.flatMap((h) => h.lines.filter((l) => l.startsWith("-")).map((l) => l.slice(1))).join("\n");
      edits.push({
        file: filePath,
        search: content,
        replace: ""
      });
      continue;
    }
    for (const hunk of file.hunks) {
      const { search, replace } = extractHunkEdit(hunk);
      if (search === replace) continue;
      edits.push({
        file: filePath,
        search,
        replace
      });
    }
  }
  return edits;
}
function parseDiffFiles(diff) {
  const files = [];
  const lines = diff.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("diff --git")) {
      i++;
      continue;
    }
    const file = {
      oldPath: null,
      newPath: null,
      hunks: [],
      isBinary: false,
      isNew: false,
      isDeleted: false
    };
    i++;
    while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git")) {
      const line = lines[i];
      if (line.startsWith("--- ")) {
        const path = line.slice(4);
        file.oldPath = path === "/dev/null" ? null : path.replace(/^[ab]\//, "");
        if (path === "/dev/null") file.isNew = true;
      } else if (line.startsWith("+++ ")) {
        const path = line.slice(4);
        file.newPath = path === "/dev/null" ? null : path.replace(/^[ab]\//, "");
        if (path === "/dev/null") file.isDeleted = true;
      } else if (line.startsWith("Binary files")) {
        file.isBinary = true;
      } else if (line.startsWith("new file mode")) {
        file.isNew = true;
      } else if (line.startsWith("deleted file mode")) {
        file.isDeleted = true;
      }
      i++;
    }
    while (i < lines.length && !lines[i].startsWith("diff --git")) {
      if (lines[i].startsWith("@@")) {
        const hunk = parseHunk(lines, i);
        file.hunks.push(hunk.hunk);
        i = hunk.nextLine;
      } else {
        i++;
      }
    }
    files.push(file);
  }
  return files;
}
function parseHunk(lines, start) {
  const headerMatch = lines[start].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!headerMatch) {
    return {
      hunk: { oldStart: 0, oldCount: 0, newStart: 0, newCount: 0, lines: [] },
      nextLine: start + 1
    };
  }
  const hunk = {
    oldStart: parseInt(headerMatch[1], 10),
    oldCount: parseInt(headerMatch[2] ?? "1", 10),
    newStart: parseInt(headerMatch[3], 10),
    newCount: parseInt(headerMatch[4] ?? "1", 10),
    lines: []
  };
  let i = start + 1;
  while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git")) {
    const line = lines[i];
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "") {
      hunk.lines.push(line);
    } else if (line.startsWith("\\")) {
    } else {
      break;
    }
    i++;
  }
  return { hunk, nextLine: i };
}
function extractHunkEdit(hunk) {
  const searchLines = [];
  const replaceLines = [];
  for (const line of hunk.lines) {
    if (line.startsWith("-")) {
      searchLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      replaceLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      searchLines.push(line.slice(1));
      replaceLines.push(line.slice(1));
    } else if (line === "") {
      searchLines.push("");
      replaceLines.push("");
    }
  }
  return {
    search: searchLines.join("\n"),
    replace: replaceLines.join("\n")
  };
}

// src/extractor/shared/security.ts
function emitSecurityPredicates(opts = {}) {
  const checks = [
    "secrets_in_code",
    "xss",
    "sql_injection"
  ];
  return checks.map((check) => {
    const predicate = {
      type: "security",
      securityCheck: check,
      expected: "no_findings"
    };
    if (opts.descriptions?.[check]) {
      predicate.description = opts.descriptions[check];
    }
    return predicate;
  });
}

// src/extractor/tier1-diff.ts
function tier1Diff(edits) {
  const predicates = [];
  for (const edit of edits) {
    if (!edit.search && edit.replace) {
      predicates.push({
        type: "filesystem_exists",
        file: edit.file,
        description: `New file "${edit.file}" should exist after edit`
      });
      const significantLines = edit.replace.split("\n").map((l) => l.trim()).filter((l) => l.length > 10 && !l.startsWith("//") && !l.startsWith("#") && !l.startsWith("*"));
      if (significantLines.length > 0) {
        predicates.push({
          type: "content",
          file: edit.file,
          pattern: significantLines[0],
          description: `New file should contain: "${significantLines[0].substring(0, 50)}"`
        });
      }
      continue;
    }
    if (edit.search && !edit.replace) {
      predicates.push({
        type: "filesystem_absent",
        file: edit.file,
        description: `Deleted file "${edit.file}" should not exist after edit`
      });
      continue;
    }
    if (edit.search && edit.replace) {
      const added = findUniqueSubstrings(edit.replace, edit.search);
      const removed = findUniqueSubstrings(edit.search, edit.replace);
      for (const a of added.slice(0, 3)) {
        predicates.push({
          type: "content",
          file: edit.file,
          pattern: a,
          description: `Edit adds "${a.substring(0, 40)}" \u2014 should exist post-edit`
        });
      }
      for (const r of removed.slice(0, 2)) {
        predicates.push({
          type: "content",
          file: edit.file,
          pattern: r,
          description: `Edit removes "${r.substring(0, 40)}" \u2014 should be gone post-edit`,
          // Note: this predicate SHOULD FAIL if the pattern still exists.
          // The caller should set expectedSuccess=false or use expected='absent'
          expected: "absent"
        });
      }
    }
  }
  const codeExts = /* @__PURE__ */ new Set([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".py", ".rb", ".php"]);
  const codeFiles = [...new Set(edits.map((e) => e.file))].filter((f) => codeExts.has("." + f.split(".").pop()));
  if (codeFiles.length > 0) {
    predicates.push(...emitSecurityPredicates({
      descriptions: {
        secrets_in_code: "Auto-scan: no hardcoded secrets in edited code files",
        xss: "Auto-scan: no XSS patterns in edited code files",
        sql_injection: "Auto-scan: no SQL injection patterns in edited code files"
      }
    }));
  }
  return predicates;
}
function findUniqueSubstrings(a, b) {
  const results = [];
  const tokensA = extractTokens(a);
  const tokensB = new Set(extractTokens(b));
  for (const token of tokensA) {
    if (!tokensB.has(token) && token.length >= 3) {
      results.push(token);
    }
  }
  return [...new Set(results)];
}
function extractTokens(s) {
  const tokens = [];
  const quoted = s.match(/['"`]([^'"`\n]{3,60})['"`]/g);
  if (quoted) tokens.push(...quoted.map((q) => q.slice(1, -1)));
  const identifiers = s.match(/\b[a-zA-Z_][\w.-]{2,40}\b/g);
  if (identifiers) tokens.push(...identifiers);
  const selectors = s.match(/[.#][\w-]{2,30}/g);
  if (selectors) tokens.push(...selectors);
  const routes = s.match(/\/[\w/-]{2,40}/g);
  if (routes) tokens.push(...routes);
  const numbers = s.match(/\b\d{2,5}\b/g);
  if (numbers) tokens.push(...numbers);
  return tokens;
}

// src/extractor/tier2-context.ts
function tier2Context(edits, existingFiles) {
  const predicates = [];
  if (!existingFiles || existingFiles.length === 0) return predicates;
  const editedFiles = new Set(edits.map((e) => e.file));
  for (const edit of edits) {
    if (!edit.search || !edit.replace) continue;
    const removed = findUniqueSubstrings2(edit.search, edit.replace);
    for (const removedStr of removed) {
      if (removedStr.length < 4) continue;
      for (const otherFile of existingFiles) {
        if (editedFiles.has(otherFile)) continue;
        if (otherFile === edit.file) continue;
        if (looksLikeReference(removedStr, edit.file, otherFile)) {
          predicates.push({
            type: "content",
            file: otherFile,
            pattern: removedStr,
            description: `"${removedStr.substring(0, 30)}" removed from ${edit.file} \u2014 check if ${otherFile} still references it`,
            expected: "absent"
          });
        }
      }
    }
  }
  return predicates;
}
function findUniqueSubstrings2(a, b) {
  const results = [];
  const tokensA = extractTokens2(a);
  const tokensB = new Set(extractTokens2(b));
  for (const token of tokensA) {
    if (!tokensB.has(token) && token.length >= 3) {
      results.push(token);
    }
  }
  return [...new Set(results)];
}
function extractTokens2(s) {
  const tokens = [];
  const quoted = s.match(/['"`]([^'"`\n]{3,60})['"`]/g);
  if (quoted) tokens.push(...quoted.map((q) => q.slice(1, -1)));
  const identifiers = s.match(/\b[a-zA-Z_][\w.-]{2,40}\b/g);
  if (identifiers) tokens.push(...identifiers);
  const selectors = s.match(/[.#][\w-]{2,30}/g);
  if (selectors) tokens.push(...selectors);
  const routes = s.match(/\/[\w/-]{2,40}/g);
  if (routes) tokens.push(...routes);
  const numbers = s.match(/\b\d{2,5}\b/g);
  if (numbers) tokens.push(...numbers);
  return tokens;
}
function looksLikeReference(removedStr, sourceFile, otherFile) {
  if (removedStr.startsWith("/") && (otherFile.includes("docker") || otherFile.includes("config") || otherFile.includes(".env") || otherFile.includes("server"))) return true;
  if (/^\d{4,5}$/.test(removedStr) && (otherFile.includes("docker") || otherFile.includes("config") || otherFile.includes(".env") || otherFile.includes("Dockerfile"))) return true;
  if (removedStr.startsWith(".") && otherFile.match(/\.(html|jsx?|tsx?)$/)) return true;
  return false;
}

// src/extractor/tier3-intent.ts
function tier3Intent(edits, context) {
  const predicates = [];
  const allText = [context.title, context.description, context.issueTitle, ...context.commitMessages ?? []].filter(Boolean).join(" ");
  if (!allText) return predicates;
  const quoted = allText.match(/[`'"]([\w.#-]{3,40})[`'"]/g) ?? [];
  for (const q of quoted) {
    const value = q.slice(1, -1);
    const targetEdit = edits.find((e) => e.replace?.includes(value) || e.search?.includes(value));
    if (targetEdit) {
      predicates.push({
        type: "content",
        file: targetEdit.file,
        pattern: value,
        description: `PR mentions "${value}" \u2014 should exist in ${targetEdit.file} post-edit`
      });
    }
  }
  const cssUtilities = allText.match(/\b[a-z][\w]*-[\w-]{1,30}\b/g) ?? [];
  for (const cls of cssUtilities) {
    const targetEdit = edits.find((e) => e.replace?.includes(cls) || e.search?.includes(cls));
    if (targetEdit) {
      predicates.push({
        type: "content",
        file: targetEdit.file,
        pattern: cls,
        description: `PR mentions "${cls}" \u2014 should exist in ${targetEdit.file} post-edit`
      });
    }
  }
  const selectors = allText.match(/[.#][\w-]{2,30}/g) ?? [];
  for (const sel of selectors) {
    const targetEdit = edits.find((e) => e.file.match(/\.(css|scss|less|tsx?|jsx?|html)$/));
    if (targetEdit) {
      predicates.push({
        type: "content",
        file: targetEdit.file,
        pattern: sel,
        description: `PR references selector "${sel}" \u2014 should exist post-edit`
      });
    }
  }
  const routes = allText.match(/\/[\w/-]{2,40}/g) ?? [];
  for (const route of routes) {
    if (route.startsWith("/api/") || route.startsWith("/health") || route.match(/^\/[\w-]+$/)) {
      const serverEdit = edits.find((e) => e.file.match(/server|app|index|route/i));
      if (serverEdit) {
        predicates.push({
          type: "content",
          file: serverEdit.file,
          pattern: route,
          description: `PR mentions route "${route}" \u2014 should exist in server post-edit`
        });
      }
    }
  }
  return predicates;
}

// src/verify.ts
var import_fs22 = require("fs");
var import_path22 = require("path");
var import_os = require("os");

// src/store/constraint-store.ts
var import_fs = require("fs");
var import_path = require("path");
var CONSTRAINT_TTL_MS = 60 * 60 * 1e3;
var MAX_CONSTRAINT_DEPTH = 5;
var MAX_OUTCOMES = 100;
var RADIUS_MAP = {
  2: 5,
  3: 3,
  4: 2
};
var RADIUS_MIN = 1;
var ConstraintStore = class {
  stateDir;
  dataPath;
  data;
  totalEverSeeded = 0;
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.dataPath = (0, import_path.join)(stateDir, "memory.jsonl");
    this.data = this.load();
  }
  // ---------------------------------------------------------------------------
  // LOAD / SAVE — Append-only JSONL
  // ---------------------------------------------------------------------------
  load() {
    const legacyPath = (0, import_path.join)(this.stateDir, "memory.json");
    if (!(0, import_fs.existsSync)(this.dataPath) && (0, import_fs.existsSync)(legacyPath)) {
      this.migrateFromJson(legacyPath);
    }
    if (!(0, import_fs.existsSync)(this.dataPath)) {
      return { constraints: [], outcomes: [], patterns: [] };
    }
    try {
      const raw = (0, import_fs.readFileSync)(this.dataPath, "utf-8");
      return this.replayLog(raw);
    } catch {
      return { constraints: [], outcomes: [], patterns: [] };
    }
  }
  /**
   * Replay the append-only log to rebuild in-memory state.
   * Each line is a JSON object with an `_op` field indicating the operation.
   */
  replayLog(raw) {
    const data = { constraints: [], outcomes: [], patterns: [] };
    const lines = raw.split("\n").filter((l) => l.trim());
    let totalSeeded = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        switch (entry._op) {
          case "constraint":
            data.constraints.push(entry.data);
            totalSeeded++;
            break;
          case "outcome":
            data.outcomes.push(entry.data);
            break;
          case "pattern":
            const idx = data.patterns.findIndex((p) => p.signature === entry.data.signature);
            if (idx >= 0) data.patterns[idx] = entry.data;
            else data.patterns.push(entry.data);
            break;
          case "cleanup": {
            const { sessionId, expireBefore } = entry.data;
            data.constraints = data.constraints.filter((c) => {
              if (c.sessionId === sessionId && c.sessionScope) return false;
              if (expireBefore && c.expiresAt && c.expiresAt < expireBefore) return false;
              return true;
            });
            break;
          }
          case "compact":
            data.constraints = entry.data.constraints ?? [];
            totalSeeded += data.constraints.length;
            data.outcomes = entry.data.outcomes ?? [];
            data.patterns = entry.data.patterns ?? [];
            break;
        }
      } catch {
      }
    }
    this.totalEverSeeded = totalSeeded;
    return data;
  }
  /**
   * Migrate from legacy memory.json to memory.jsonl.
   */
  migrateFromJson(legacyPath) {
    try {
      const raw = (0, import_fs.readFileSync)(legacyPath, "utf-8");
      const parsed = JSON.parse(raw);
      (0, import_fs.mkdirSync)((0, import_path.dirname)(this.dataPath), { recursive: true });
      const compactEntry = {
        _op: "compact",
        _ts: Date.now(),
        data: {
          constraints: parsed.constraints ?? [],
          outcomes: parsed.outcomes ?? [],
          patterns: parsed.patterns ?? []
        }
      };
      (0, import_fs.appendFileSync)(this.dataPath, JSON.stringify(compactEntry) + "\n");
      (0, import_fs.unlinkSync)(legacyPath);
    } catch {
    }
  }
  /** Append a single entry to the log file. */
  appendEntry(op, data) {
    (0, import_fs.mkdirSync)((0, import_path.dirname)(this.dataPath), { recursive: true });
    const entry = { _op: op, _ts: Date.now(), data };
    (0, import_fs.appendFileSync)(this.dataPath, JSON.stringify(entry) + "\n");
  }
  /**
   * Compact the log when it grows too large.
   * Replaces the entire file with a single snapshot of current state.
   */
  compact() {
    (0, import_fs.mkdirSync)((0, import_path.dirname)(this.dataPath), { recursive: true });
    if (this.data.outcomes.length > MAX_OUTCOMES) {
      this.data.outcomes = this.data.outcomes.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_OUTCOMES);
    }
    const compactEntry = {
      _op: "compact",
      _ts: Date.now(),
      data: {
        constraints: this.data.constraints,
        outcomes: this.data.outcomes,
        patterns: this.data.patterns
      }
    };
    (0, import_fs.writeFileSync)(this.dataPath, JSON.stringify(compactEntry) + "\n");
  }
  /**
   * Get the path to the data file (for external tooling / tests).
   */
  getDataPath() {
    return this.dataPath;
  }
  // ---------------------------------------------------------------------------
  // K5: CONSTRAINT CHECK — Does this plan violate any learned constraints?
  // ---------------------------------------------------------------------------
  checkConstraints(filesTouched, changeType, predicateFingerprints) {
    const now = Date.now();
    for (const c of this.data.constraints) {
      if (c.expiresAt && c.expiresAt < now) continue;
      if (c.appliesTo.length > 0 && !c.appliesTo.includes(changeType)) continue;
      if (c.requires.bannedPredicateFingerprints && predicateFingerprints) {
        for (const banned of c.requires.bannedPredicateFingerprints) {
          if (predicateFingerprints.includes(banned)) {
            return {
              constraintId: c.id,
              signature: c.signature,
              type: c.type,
              reason: c.reason,
              banType: "predicate_fingerprint"
            };
          }
        }
      }
      if (c.type === "goal_drift_ban") {
        return {
          constraintId: c.id,
          signature: c.signature,
          type: c.type,
          reason: c.reason,
          banType: "goal_drift"
        };
      }
      if (c.type === "radius_limit" && c.requires.maxFiles) {
        if (filesTouched.length > c.requires.maxFiles) {
          return {
            constraintId: c.id,
            signature: c.signature,
            type: c.type,
            reason: `Plan touches ${filesTouched.length} files, limit is ${c.requires.maxFiles}`,
            banType: "radius_limit"
          };
        }
      }
      if (c.type === "forbidden_action") {
        if (c.requires.bannedPredicateFingerprints && c.requires.bannedPredicateFingerprints.length > 0) {
          continue;
        }
        if (c.surface.files.length === 0) {
          return {
            constraintId: c.id,
            signature: c.signature,
            type: c.type,
            reason: c.reason,
            banType: "action_class"
          };
        }
        const touchesConstrained = filesTouched.some(
          (f) => c.surface.files.some((cf) => f.includes(cf) || cf.includes(f))
        );
        if (touchesConstrained) {
          if (c.requires.patterns && c.requires.patterns.length > 0) {
            return {
              constraintId: c.id,
              signature: c.signature,
              type: c.type,
              reason: c.reason,
              banType: "file_pattern"
            };
          }
        }
      }
    }
    return null;
  }
  // ---------------------------------------------------------------------------
  // K5: CONSTRAINT SEEDING — Learn from failures
  // ---------------------------------------------------------------------------
  seedFromFailure(event) {
    if (!event.failureKind) {
      event.failureKind = classifyFailureKind(event.error, event.source);
    }
    if (event.failureKind === "harness_fault") return null;
    if (event.source === "syntax") return null;
    const sessionConstraints = this.data.constraints.filter(
      (c) => c.sessionId === event.sessionId && c.sessionScope
    );
    if (sessionConstraints.length >= MAX_CONSTRAINT_DEPTH) return null;
    const signature = event.signature ?? extractSignature(event.error);
    const sessionFailureCount = this.countSessionFailures(event.sessionId, signature);
    let constraint = null;
    if (event.actionClass && sessionFailureCount >= 2) {
      constraint = this.buildStrategyBan(event);
    }
    if (!constraint && event.attempt >= 2) {
      constraint = this.buildRadiusLimit(event);
    }
    if (!constraint && event.source === "evidence") {
      constraint = this.buildEvidenceConstraint(event);
    }
    if (!constraint) return null;
    const isDupe = this.data.constraints.some(
      (c) => c.sessionId === event.sessionId && c.type === constraint.type && c.signature === constraint.signature
    );
    if (isDupe) return null;
    this.data.constraints.push(constraint);
    this.totalEverSeeded++;
    this.appendEntry("constraint", constraint);
    return constraint;
  }
  // ---------------------------------------------------------------------------
  // OUTCOME RECORDING
  // ---------------------------------------------------------------------------
  recordOutcome(outcome) {
    this.data.outcomes.push(outcome);
    this.appendEntry("outcome", outcome);
    if (!outcome.success && outcome.signature) {
      const existing = this.data.patterns.find((p) => p.signature === outcome.signature);
      if (existing) {
        existing.occurrences++;
        existing.lastSeen = outcome.timestamp;
        existing.affectedFiles = [.../* @__PURE__ */ new Set([...existing.affectedFiles, ...outcome.filesTouched])];
        this.appendEntry("pattern", existing);
      } else {
        const pattern = {
          signature: outcome.signature,
          occurrences: 1,
          lastSeen: outcome.timestamp,
          winningFixes: [],
          affectedFiles: [...outcome.filesTouched]
        };
        this.data.patterns.push(pattern);
        this.appendEntry("pattern", pattern);
      }
    }
    if (outcome.success && outcome.signature) {
      const pattern = this.data.patterns.find((p) => p.signature === outcome.signature);
      if (pattern && outcome.goal) {
        pattern.winningFixes.push(outcome.goal);
        if (pattern.winningFixes.length > 5) {
          pattern.winningFixes = pattern.winningFixes.slice(-5);
        }
        this.appendEntry("pattern", pattern);
      }
    }
  }
  // ---------------------------------------------------------------------------
  // SESSION CLEANUP
  // ---------------------------------------------------------------------------
  cleanupSession(sessionId) {
    const now = Date.now();
    const before = this.data.constraints.length;
    this.data.constraints = this.data.constraints.filter((c) => {
      if (c.sessionId === sessionId && c.sessionScope) return false;
      if (c.expiresAt && c.expiresAt < now) return false;
      return true;
    });
    if (this.data.constraints.length !== before) {
      this.appendEntry("cleanup", { sessionId, expireBefore: now });
    }
  }
  // ---------------------------------------------------------------------------
  // PATTERN RECALL
  // ---------------------------------------------------------------------------
  getPatternRecall(error) {
    const sig = extractSignature(error);
    if (!sig) return void 0;
    const pattern = this.data.patterns.find((p) => p.signature === sig);
    if (!pattern || pattern.winningFixes.length === 0) return void 0;
    return `Known pattern "${sig}" (seen ${pattern.occurrences}x). Prior fixes: ${pattern.winningFixes.join("; ")}`;
  }
  // ---------------------------------------------------------------------------
  // ACCESSORS
  // ---------------------------------------------------------------------------
  getConstraints() {
    return this.data.constraints;
  }
  getOutcomes() {
    return this.data.outcomes;
  }
  getPatterns() {
    return this.data.patterns;
  }
  getConstraintCount() {
    return this.totalEverSeeded;
  }
  getActiveConstraintCount() {
    return this.data.constraints.length;
  }
  // ---------------------------------------------------------------------------
  // INTERNAL BUILDERS
  // ---------------------------------------------------------------------------
  buildStrategyBan(event) {
    return {
      id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: "forbidden_action",
      signature: event.actionClass ?? "unknown_strategy",
      scope: "planning",
      appliesTo: event.changeType ? [event.changeType] : [],
      surface: { files: [], intents: [] },
      requires: {},
      reason: `Strategy "${event.actionClass}" failed ${event.attempt}+ times`,
      introducedAt: Date.now(),
      sessionId: event.sessionId,
      sessionScope: true,
      expiresAt: Date.now() + CONSTRAINT_TTL_MS
    };
  }
  buildRadiusLimit(event) {
    const maxFiles = RADIUS_MAP[event.attempt] ?? RADIUS_MIN;
    return {
      id: `c_radius_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: "radius_limit",
      signature: `radius_${maxFiles}`,
      scope: "planning",
      appliesTo: [],
      surface: { files: event.filesTouched, intents: [] },
      requires: { maxFiles },
      reason: `Attempt ${event.attempt}: shrinking allowed file count to ${maxFiles}`,
      introducedAt: Date.now(),
      sessionId: event.sessionId,
      sessionScope: true,
      expiresAt: Date.now() + CONSTRAINT_TTL_MS
    };
  }
  buildEvidenceConstraint(event) {
    if (event.failedPredicates && event.failedPredicates.length > 0) {
      const fingerprints = event.failedPredicates.map((p) => predicateFingerprint(p));
      return {
        id: `c_evidence_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: "forbidden_action",
        signature: event.signature ?? "evidence_failure",
        scope: "planning",
        appliesTo: [],
        surface: { files: event.filesTouched, intents: [] },
        requires: { bannedPredicateFingerprints: fingerprints },
        reason: `Post-deploy evidence failed: ${event.error.substring(0, 100)}`,
        introducedAt: Date.now(),
        sessionId: event.sessionId,
        sessionScope: true,
        expiresAt: Date.now() + CONSTRAINT_TTL_MS * 2
      };
    }
    return {
      id: `c_evidence_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: "forbidden_action",
      signature: event.signature ?? "evidence_failure",
      scope: "planning",
      appliesTo: [],
      surface: { files: event.filesTouched, intents: [] },
      requires: {},
      reason: `Post-deploy evidence failed: ${event.error.substring(0, 100)}`,
      introducedAt: Date.now(),
      sessionId: event.sessionId,
      sessionScope: true,
      expiresAt: Date.now() + CONSTRAINT_TTL_MS * 2
    };
  }
  countSessionFailures(sessionId, signature) {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1e3;
    return this.data.outcomes.filter(
      (o) => !o.success && o.sessionId === sessionId && o.failureKind !== "harness_fault" && o.timestamp > twoHoursAgo && (!signature || o.signature === signature)
    ).length;
  }
};
function extractSignature(error) {
  if (!error) return void 0;
  const signatures = [
    [/search string not found|edit application failed/i, "edit_not_applicable"],
    [/browser gate failed/i, "browser_gate_failed"],
    [/getaddrinfo.*(eai_again|enotfound)/i, "dns_resolution_failed"],
    [/timeout|exceeded time/i, "migration_timeout"],
    [/eaddrinuse|port.*in use/i, "port_conflict"],
    [/syntaxerror|unexpected token|unterminated string/i, "syntax_error"],
    [/cannot find module/i, "missing_module"],
    [/build fail|exit code [1-9]/i, "build_failure"],
    [/health check fail|502/i, "health_check_failure"],
    [/econnrefused/i, "connection_refused"],
    [/out of memory|oom/i, "oom_killed"],
    [/element not found in dom/i, "selector_not_found"],
    [/actual vs expected|value mismatch/i, "css_value_mismatch"],
    [/predicate.*failed|evidence failed/i, "predicate_mismatch"]
  ];
  for (const [regex, sig] of signatures) {
    if (regex.test(error)) return sig;
  }
  return void 0;
}
function classifyFailureKind(error, source) {
  if (!error) return "unknown";
  if (/getaddrinfo.*(eai_again|enotfound)|eai_again|enotfound/i.test(error)) return "harness_fault";
  if (/econnrefused|connection refused/i.test(error) && source === "staging") return "harness_fault";
  if (/eaddrinuse|port.*in use|address.*in use/i.test(error)) return "harness_fault";
  if (/docker.*daemon.*not running|cannot connect to.*docker/i.test(error)) return "harness_fault";
  if (/timeout|timed?\s*out/i.test(error) && source === "staging") return "harness_fault";
  if (/syntaxerror|unexpected token|unterminated string/i.test(error) && (source === "staging" || source === "evidence" || source === "syntax")) {
    return "app_failure";
  }
  if (/build fail/i.test(error) && source === "staging") return "app_failure";
  if (/cannot find module/i.test(error)) return "app_failure";
  if (/predicate.*failed|evidence failed|value mismatch/i.test(error)) return "app_failure";
  return "unknown";
}
function predicateFingerprint(p) {
  const parts = [`type=${p.type}`];
  if (p.selector != null) parts.push(`selector=${p.selector}`);
  if (p.property != null) parts.push(`property=${p.property}`);
  if (p.expected != null) parts.push(`exp=${p.expected}`);
  if (p.path != null) parts.push(`path=${p.path}`);
  if (p.method != null) parts.push(`method=${p.method}`);
  if (p.table != null) parts.push(`table=${p.table}`);
  if (p.pattern != null) parts.push(`pattern=${p.pattern}`);
  if (p.count != null) parts.push(`count=${p.count}`);
  if (p.hash != null) parts.push(`hash=${p.hash.slice(0, 16)}`);
  if (p.expect) {
    if (p.expect.status != null) parts.push(`status=${p.expect.status}`);
    if (p.expect.bodyContains != null) {
      const bc = Array.isArray(p.expect.bodyContains) ? p.expect.bodyContains.join(",") : p.expect.bodyContains;
      parts.push(`body=${bc}`);
    }
    if (p.expect.bodyRegex != null) parts.push(`regex=${p.expect.bodyRegex}`);
  }
  if (p.steps && p.steps.length > 0) {
    const stepSig = p.steps.map((s) => `${s.method}:${s.path}`).join("+");
    parts.push(`steps=${stepSig}`);
  }
  return parts.join("|");
}
function classifyChangeType(files) {
  const categories = /* @__PURE__ */ new Set();
  for (const f of files) {
    const lower = f.toLowerCase();
    if (/\.css$|\.scss$|\.sass$|\.less$|styles?[./]|\.html$|\.hbs$|\.ejs$|\.pug$/.test(lower)) {
      categories.add("ui");
    } else if (/migration|\.sql$|init\.sql|schema/.test(lower)) {
      categories.add("schema");
    } else if (/dockerfile|docker-compose|\.env|\.yml$|\.yaml$|caddy|nginx/i.test(lower)) {
      if (/docker-compose\.staging/i.test(lower)) continue;
      categories.add(/dockerfile|docker-compose/i.test(lower) ? "config" : "infra");
    } else if (/package\.json|tsconfig|\.config\./i.test(lower)) {
      categories.add("config");
    } else {
      categories.add("logic");
    }
  }
  if (categories.size === 0) return "ui";
  if (categories.size === 1) return [...categories][0];
  return "mixed";
}
function classifyActionClass(edits, predicateFiles) {
  if (edits.length === 0) return void 0;
  for (const e of edits) {
    if (e.search && e.replace && e.replace.length > 0) {
      if (e.search.length > 200 && e.replace.length / e.search.length > 0.5) {
        return "rewrite_page";
      }
    }
  }
  const replacePatterns = /* @__PURE__ */ new Map();
  for (const e of edits) {
    if (e.search && e.search.length < 50) {
      const key = e.search.trim();
      replacePatterns.set(key, (replacePatterns.get(key) ?? 0) + 1);
    }
  }
  for (const count of replacePatterns.values()) {
    if (count >= 3) return "global_replace";
  }
  for (const e of edits) {
    if (e.file.match(/migration|\.sql$/i)) return "schema_migration";
  }
  let cssChanges = 0;
  for (const e of edits) {
    if (e.file.match(/\.css$|\.scss$|styles/) || e.replace && /[{};]/.test(e.replace)) {
      cssChanges++;
    }
  }
  if (cssChanges > 5) return "style_overhaul";
  if (predicateFiles && predicateFiles.length > 0) {
    const unrelated = edits.filter((e) => !predicateFiles.some((pf) => e.file.includes(pf)));
    if (unrelated.length > edits.length * 0.5) return "unrelated_edit";
  }
  return void 0;
}

// src/gates/syntax.ts
var import_fs2 = require("fs");
var import_path2 = require("path");
function runSyntaxGate(ctx) {
  const start = Date.now();
  const failures = [];
  for (const edit of ctx.edits) {
    const filePath = (0, import_path2.join)(ctx.stageDir ?? ctx.config.appDir, edit.file);
    if (!(0, import_fs2.existsSync)(filePath)) {
      if (edit.search === "" && edit.replace) {
        continue;
      }
      failures.push({ file: edit.file, search: edit.search.substring(0, 80), reason: "file_missing" });
      continue;
    }
    if (!edit.search) {
      failures.push({ file: edit.file, search: "(empty)", reason: "ambiguous_match", matchCount: -1 });
      continue;
    }
    const content = (0, import_fs2.readFileSync)(filePath, "utf-8").replace(/\r\n/g, "\n");
    const search = edit.search.replace(/\r\n/g, "\n");
    let count = 0;
    let idx = 0;
    while (true) {
      idx = content.indexOf(search, idx);
      if (idx === -1) break;
      count++;
      idx += search.length;
    }
    if (count === 0) {
      failures.push({
        file: edit.file,
        search: edit.search.substring(0, 80),
        reason: "not_found"
      });
    } else if (count > 1) {
      failures.push({
        file: edit.file,
        search: edit.search.substring(0, 80),
        reason: "ambiguous_match",
        matchCount: count
      });
    }
  }
  const passed = failures.length === 0;
  const durationMs = Date.now() - start;
  let detail;
  if (passed) {
    detail = `All ${ctx.edits.length} edit(s) have unique search strings`;
  } else {
    const reasons = failures.map((f) => {
      if (f.reason === "file_missing") return `${f.file}: file not found`;
      if (f.reason === "not_found") return `${f.file}: search string not found`;
      return `${f.file}: ambiguous match (${f.matchCount} occurrences)`;
    });
    detail = reasons.join("; ");
  }
  return { gate: "F9", passed, detail, durationMs, failures };
}
function applyEdits(edits, targetDir) {
  const results = [];
  for (const edit of edits) {
    const filePath = (0, import_path2.join)(targetDir, edit.file);
    if (!(0, import_fs2.existsSync)(filePath)) {
      if (edit.search === "" && edit.replace) {
        try {
          const dir = filePath.substring(0, filePath.lastIndexOf("/") > 0 ? filePath.lastIndexOf("/") : filePath.lastIndexOf("\\"));
          if (dir && !(0, import_fs2.existsSync)(dir)) {
            const { mkdirSync: mkdirSync5 } = require("fs");
            mkdirSync5(dir, { recursive: true });
          }
          const { writeFileSync: wfs } = require("fs");
          wfs(filePath, edit.replace.replace(/\r\n/g, "\n"), "utf-8");
          results.push({ file: edit.file, applied: true });
        } catch (e) {
          results.push({ file: edit.file, applied: false, reason: `create failed: ${e.message}` });
        }
        continue;
      }
      results.push({ file: edit.file, applied: false, reason: "file not found" });
      continue;
    }
    const rawContent = (0, import_fs2.readFileSync)(filePath, "utf-8");
    const content = rawContent.replace(/\r\n/g, "\n");
    const search = edit.search.replace(/\r\n/g, "\n");
    const idx = content.indexOf(search);
    if (idx === -1) {
      results.push({ file: edit.file, applied: false, reason: "search string not found" });
      continue;
    }
    const secondIdx = content.indexOf(search, idx + 1);
    if (secondIdx !== -1) {
      results.push({ file: edit.file, applied: false, reason: "ambiguous match" });
      continue;
    }
    const { writeFileSync: writeFileSync4 } = require("fs");
    const replace = edit.replace.replace(/\r\n/g, "\n");
    const newContent = content.slice(0, idx) + replace + content.slice(idx + search.length);
    writeFileSync4(filePath, newContent, "utf-8");
    results.push({ file: edit.file, applied: true });
  }
  return results;
}

// src/gates/constraints.ts
function runConstraintGate(ctx, store, overrideConstraints) {
  const start = Date.now();
  const filesTouched = [...new Set(ctx.edits.map((e) => e.file))];
  const changeType = classifyChangeType(filesTouched);
  const fingerprints = ctx.predicates.map((p) => predicateFingerprint(p));
  const violation = store.checkConstraints(filesTouched, changeType, fingerprints);
  if (violation && overrideConstraints?.includes(violation.constraintId)) {
    return {
      gate: "K5",
      passed: true,
      detail: `Constraint ${violation.signature} overridden by caller`,
      durationMs: Date.now() - start,
      constraintCount: store.getConstraintCount()
    };
  }
  if (violation) {
    return {
      gate: "K5",
      passed: false,
      detail: `This approach already failed: ${violation.reason}`,
      durationMs: Date.now() - start,
      violation,
      constraintCount: store.getConstraintCount()
    };
  }
  return {
    gate: "K5",
    passed: true,
    detail: `${store.getConstraintCount()} active constraint(s), none violated`,
    durationMs: Date.now() - start,
    constraintCount: store.getConstraintCount()
  };
}

// src/gates/containment.ts
function runContainmentGate(ctx) {
  const start = Date.now();
  const attributions = [];
  for (const edit of ctx.edits) {
    const attr = attributeEdit(edit, ctx.predicates);
    attributions.push(attr);
  }
  const summary = {
    total: attributions.length,
    direct: attributions.filter((a) => a.attribution === "direct").length,
    scaffolding: attributions.filter((a) => a.attribution === "scaffolding").length,
    unexplained: attributions.filter((a) => a.attribution === "unexplained").length
  };
  const passed = true;
  let detail;
  if (summary.unexplained === 0) {
    detail = `All ${summary.total} edit(s) traced to predicates (${summary.direct} direct, ${summary.scaffolding} scaffolding)`;
  } else {
    detail = `${summary.unexplained}/${summary.total} edit(s) unexplained \u2014 no predicate covers: ${attributions.filter((a) => a.attribution === "unexplained").map((a) => a.file).join(", ")}`;
  }
  return { gate: "G5", passed, detail, durationMs: Date.now() - start, attributions, summary };
}
function attributeEdit(edit, predicates) {
  for (const p of predicates) {
    if ((p.type === "css" || p.type === "html") && isLikelySourceFile(edit.file)) {
      if (p.selector && edit.replace.includes(p.selector.replace(".", ""))) {
        return { file: edit.file, attribution: "direct", matchedPredicate: describePredicate(p) };
      }
      if (p.property && edit.replace.includes(p.property)) {
        return { file: edit.file, attribution: "direct", matchedPredicate: describePredicate(p) };
      }
      if (p.expected && p.expected !== "exists" && edit.replace.includes(p.expected)) {
        return { file: edit.file, attribution: "direct", matchedPredicate: describePredicate(p) };
      }
    }
    if (p.type === "content" && p.file && edit.file.includes(p.file)) {
      return { file: edit.file, attribution: "direct", matchedPredicate: describePredicate(p) };
    }
    if ((p.type === "http" || p.type === "http_sequence") && isRouteFile(edit.file)) {
      if (p.path && edit.replace.includes(p.path)) {
        return { file: edit.file, attribution: "direct", matchedPredicate: describePredicate(p) };
      }
    }
    if (p.type === "db" && edit.file.match(/migration|\.sql$/i)) {
      return { file: edit.file, attribution: "direct", matchedPredicate: describePredicate(p) };
    }
    if (p.type.startsWith("filesystem_")) {
      const predPath = p.file ?? p.path;
      if (predPath && edit.file.includes(predPath)) {
        return { file: edit.file, attribution: "direct", matchedPredicate: describePredicate(p) };
      }
    }
  }
  if (isScaffoldingFile(edit.file)) {
    return { file: edit.file, attribution: "scaffolding" };
  }
  for (const p of predicates) {
    if (p.path && isRouteFile(edit.file)) {
      return { file: edit.file, attribution: "scaffolding", matchedPredicate: describePredicate(p) };
    }
  }
  return { file: edit.file, attribution: "unexplained" };
}
function isLikelySourceFile(file) {
  return /\.(js|ts|jsx|tsx|html|css|scss|vue|svelte|php|rb|py)$/i.test(file);
}
function isRouteFile(file) {
  return /route|server|handler|controller|api|page|app\.(js|ts)/i.test(file);
}
function isScaffoldingFile(file) {
  return /package\.json|dockerfile|docker-compose|tsconfig|\.config\.|init\.sql/i.test(file);
}
function describePredicate(p) {
  if (p.description) return p.description;
  if (p.type === "css") return `[css] ${p.selector} ${p.property}`;
  if (p.type === "html") return `[html] ${p.selector}`;
  if (p.type === "http") return `[http] ${p.method ?? "GET"} ${p.path}`;
  if (p.type === "content") return `[content] ${p.file} contains "${p.pattern?.substring(0, 30)}"`;
  if (p.type === "db") return `[db] ${p.table} ${p.assertion}`;
  if (p.type === "filesystem_exists") return `[fs_exists] ${p.file ?? p.path}`;
  if (p.type === "filesystem_absent") return `[fs_absent] ${p.file ?? p.path}`;
  if (p.type === "filesystem_unchanged") return `[fs_unchanged] ${p.file ?? p.path}`;
  if (p.type === "filesystem_count") return `[fs_count] ${p.file ?? p.path} == ${p.count}`;
  return `[${p.type}]`;
}

// src/gates/hallucination.ts
var import_fs5 = require("fs");
var import_path5 = require("path");

// src/gates/grounding.ts
var import_fs4 = require("fs");
var import_path4 = require("path");
var _groundingCache = /* @__PURE__ */ new Map();
var CACHE_TTL_MS = 5e3;
function getMaxMtime(appDir) {
  const files = findSourceFiles(appDir);
  let max = 0;
  for (const f of files) {
    try {
      const s = (0, import_fs4.statSync)(f);
      if (s.mtimeMs > max) max = s.mtimeMs;
    } catch {
    }
  }
  return max;
}
function groundInReality(appDir) {
  const cached = _groundingCache.get(appDir);
  if (cached) {
    if (Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.context;
    const currentMtime = getMaxMtime(appDir);
    if (currentMtime <= cached.maxMtimeMs) {
      cached.cachedAt = Date.now();
      return cached.context;
    }
  }
  const routeCSSMap = /* @__PURE__ */ new Map();
  const htmlElements = /* @__PURE__ */ new Map();
  const routes = [];
  const routeClassTokens = /* @__PURE__ */ new Map();
  const sourceFiles = findSourceFiles(appDir);
  for (const filePath of sourceFiles) {
    const content = (0, import_fs4.readFileSync)(filePath, "utf-8");
    if (content.length > 1e5) {
      console.warn(`[grounding] Skipping oversized file (${Math.round(content.length / 1024)}KB > 100KB): ${filePath}`);
      continue;
    }
    const fileRoutes = extractRoutes(content);
    routes.push(...fileRoutes);
    const routeBlocks = extractRouteBlocks(content);
    if (routeBlocks.size > 0) {
      for (const [route, block] of routeBlocks) {
        const cssRules = extractCSS(block);
        if (cssRules.size > 0) {
          const existing = routeCSSMap.get(route) ?? /* @__PURE__ */ new Map();
          for (const [selector, props] of cssRules) {
            const existingProps = existing.get(selector) ?? {};
            existing.set(selector, { ...existingProps, ...props });
          }
          routeCSSMap.set(route, existing);
        }
        const elements = extractHTMLElements(block);
        if (elements.length > 0) {
          const existing = htmlElements.get(route) ?? [];
          existing.push(...elements);
          htmlElements.set(route, existing);
        }
        const tokens = extractClassTokens(block, route);
        if (tokens.size > 0) {
          const existing = routeClassTokens.get(route) ?? /* @__PURE__ */ new Set();
          for (const t of tokens) existing.add(t);
          routeClassTokens.set(route, existing);
        }
      }
    } else {
      const cssRules = extractCSS(content);
      if (cssRules.size > 0) {
        const targetRoutes = fileRoutes.length > 0 ? fileRoutes : ["/"];
        for (const route of targetRoutes) {
          const existing = routeCSSMap.get(route) ?? /* @__PURE__ */ new Map();
          for (const [selector, props] of cssRules) {
            const existingProps = existing.get(selector) ?? {};
            existing.set(selector, { ...existingProps, ...props });
          }
          routeCSSMap.set(route, existing);
        }
      }
      const elements = extractHTMLElements(content);
      if (elements.length > 0) {
        const targetRoutes = fileRoutes.length > 0 ? fileRoutes : ["/"];
        for (const route of targetRoutes) {
          const existing = htmlElements.get(route) ?? [];
          existing.push(...elements);
          htmlElements.set(route, existing);
        }
      }
      for (const route of fileRoutes) {
        const tokens = extractClassTokens(content, route);
        if (tokens.size > 0) {
          const existing = routeClassTokens.get(route) ?? /* @__PURE__ */ new Set();
          for (const t of tokens) existing.add(t);
          routeClassTokens.set(route, existing);
        }
      }
    }
  }
  const uniqueRoutes = [...new Set(routes)];
  const dbSchema = findAndParseSchema(appDir);
  let infraState;
  try {
    const { findInfraDir: findInfraDir2, findAndParseState: findAndParseState2 } = (init_infrastructure(), __toCommonJS(infrastructure_exports));
    const infraDir = findInfraDir2(appDir);
    if (infraDir) infraState = findAndParseState2(infraDir);
  } catch {
  }
  const context = {
    routeCSSMap,
    htmlElements,
    routes: uniqueRoutes,
    routeClassTokens,
    ...dbSchema ? { dbSchema } : {},
    ...infraState ? { infraState } : {}
  };
  _groundingCache.set(appDir, { context, maxMtimeMs: getMaxMtime(appDir), cachedAt: Date.now() });
  return context;
}
function validateAgainstGrounding(predicates, grounding, opts) {
  return predicates.map((p) => {
    if (p.type === "css" && p.selector) {
      const targetCSS = [];
      if (p.path) {
        const routeCSS = grounding.routeCSSMap.get(p.path);
        if (routeCSS) targetCSS.push(routeCSS);
      } else {
        targetCSS.push(...grounding.routeCSSMap.values());
      }
      const found = targetCSS.some((routeCSS) => routeCSS.has(p.selector));
      if (!found) {
        const editCreatesSelector = opts?.edits?.some(
          (e) => e.replace.includes(p.selector) && !e.search.includes(p.selector)
        );
        if (!editCreatesSelector) {
          const scopeMsg = p.path ? ` on route "${p.path}"` : " in app source";
          return { ...p, groundingMiss: true, groundingReason: `CSS selector "${p.selector}" not found${scopeMsg}` };
        }
        return p;
      }
      if (p.property && p.expected && p.expected !== "exists") {
        let propertyFound = false;
        let _shVal;
        for (const routeCSS of targetCSS) {
          const sp = routeCSS.get(p.selector);
          if (sp) {
            if (p.property in sp) {
              propertyFound = true;
              break;
            }
            for (const [sh, lhs] of Object.entries(_SH)) {
              if (lhs.includes(p.property) && sh in sp) {
                propertyFound = true;
                _shVal = _rS(sh, sp[sh], p.property);
                break;
              }
            }
            if (propertyFound) break;
          }
        }
        if (!propertyFound) {
          const editAddsProperty = opts?.edits?.some((e) => {
            const prop = p.property;
            const rep = e.replace;
            const srch = e.search;
            const directMatch = rep.includes(prop) && !srch.includes(prop);
            let shorthandMatch = false;
            for (const [sh, longhands] of Object.entries(_SH)) {
              if (longhands.includes(prop) && rep.includes(sh) && !srch.includes(sh)) {
                shorthandMatch = true;
                break;
              }
            }
            if (!shorthandMatch) {
              for (const [sh, longhands] of Object.entries(_SH_EDIT_ONLY)) {
                if (longhands.includes(prop) && rep.includes(sh) && !srch.includes(sh)) {
                  shorthandMatch = true;
                  break;
                }
              }
            }
            let vendorMatch = false;
            const stripped = _stripVendor(prop);
            if (stripped && rep.includes(stripped) && !srch.includes(stripped)) {
              vendorMatch = true;
            }
            if (!vendorMatch) {
              for (const prefix of ["-webkit-", "-moz-", "-ms-", "-o-"]) {
                const vendored = prefix + prop;
                if (rep.includes(vendored) && !srch.includes(vendored)) {
                  vendorMatch = true;
                  break;
                }
              }
            }
            if (!directMatch && !shorthandMatch && !vendorMatch) return false;
            const selectorProps = targetCSS.flatMap((rc) => {
              const props = rc.get(p.selector);
              return props ? Object.keys(props) : [];
            });
            return selectorProps.some((prp) => e.search.includes(prp)) || e.search.includes(p.selector);
          });
          if (!editAddsProperty) {
            return { ...p, groundingMiss: true, groundingReason: `CSS property "${p.property}" not found on selector "${p.selector}"` };
          }
        }
        const editWouldChange = opts?.edits?.some((e) => {
          const rep = e.replace;
          if (rep.includes(p.property) && rep.includes(p.expected)) return true;
          if (rep.includes(p.property)) {
            const propIdx = rep.indexOf(p.property);
            const afterProp = rep.slice(propIdx + p.property.length);
            const valMatch = afterProp.match(/\s*:\s*([^;}\n]+)/);
            if (valMatch) {
              const editVal = valMatch[1].trim();
              if (_nC(editVal, p.property) === _nC(p.expected, p.property)) return true;
            }
          }
          for (const [sh, lhs] of Object.entries(_SH)) {
            if (lhs.includes(p.property) && rep.includes(sh + ":") || rep.includes(sh + " :")) {
              const shIdx = rep.indexOf(sh);
              const afterSh = rep.slice(shIdx + sh.length);
              const shValMatch = afterSh.match(/\s*:\s*([^;}\n]+)/);
              if (shValMatch) {
                const resolved = _rS(sh, shValMatch[1].trim(), p.property);
                if (resolved && _nC(resolved, p.property) === _nC(p.expected, p.property)) return true;
              }
            }
          }
          return false;
        });
        if (!editWouldChange) {
          if (_shVal !== void 0) {
            if (_nC(_shVal, p.property) !== _nC(p.expected, p.property)) {
              return { ...p, groundingMiss: true, groundingReason: `CSS "${p.selector}" "${p.property}" resolves to "${_shVal}" from shorthand but predicate claims "${p.expected}"` };
            }
          } else {
            for (const routeCSS of targetCSS) {
              const sp = routeCSS.get(p.selector);
              if (sp && p.property in sp) {
                if (_nC(sp[p.property], p.property) !== _nC(p.expected, p.property)) {
                  return { ...p, groundingMiss: true, groundingReason: `CSS "${p.selector}" "${p.property}" is "${sp[p.property]}" in source but predicate claims "${p.expected}"` };
                }
              }
            }
          }
        }
      }
      if (!p.path && p.property) {
        const routeValues = [];
        for (const routeCSS of targetCSS) {
          const selectorProps = routeCSS.get(p.selector);
          if (selectorProps && p.property in selectorProps) {
            routeValues.push(selectorProps[p.property]);
          }
        }
        const uniqueValues = new Set(routeValues);
        if (uniqueValues.size > 1) {
          return { ...p, groundingMiss: true, groundingReason: `CSS "${p.selector}" "${p.property}" has conflicting values across routes (${[...uniqueValues].join(" vs ")}). Add a path to scope the predicate.` };
        }
      }
    }
    if (p.type === "html" && p.selector && p.expected === "exists") {
      const bareTag = p.selector.replace(/[.#\[:].*/s, "").trim().toLowerCase();
      const targetRoutes = p.path ? [p.path] : [...grounding.htmlElements.keys()];
      let found = false;
      for (const route of targetRoutes) {
        const elements = grounding.htmlElements.get(route) ?? [];
        if (elements.some((el) => el.tag === bareTag)) {
          found = true;
          break;
        }
      }
      if (!found) {
        if (p.path) {
          const otherRoutes = [...grounding.htmlElements.keys()].filter((r) => r !== p.path);
          for (const route of otherRoutes) {
            const elements = grounding.htmlElements.get(route) ?? [];
            if (elements.some((el) => el.tag === bareTag)) {
              return { ...p, groundingMiss: true, groundingReason: `HTML element "${bareTag}" exists on route "${route}" but not on claimed route "${p.path}"` };
            }
          }
        }
        if (opts?.edits) {
          const tagPat = new RegExp(`<${bareTag}[\\s>/]`, "i");
          if (!opts.edits.some((edit) => tagPat.test(edit.replace))) {
            return { ...p, groundingMiss: true, groundingReason: `HTML element "${bareTag}" not found in app source and no edit creates it` };
          }
        } else {
          return { ...p, groundingMiss: true, groundingReason: `HTML element "${bareTag}" not found in app source` };
        }
      }
    }
    if (p.type === "html" && p.selector && p.expected && p.expected !== "exists") {
      const targetRoutes = p.path ? [p.path] : [...grounding.htmlElements.keys()];
      let elementFound = false;
      let textMatches = false;
      for (const route of targetRoutes) {
        const elements = grounding.htmlElements.get(route) ?? [];
        for (const el of elements) {
          if (el.tag === p.selector) {
            elementFound = true;
            if (el.text && el.text.includes(p.expected)) {
              textMatches = true;
              break;
            }
          }
        }
        if (textMatches) break;
      }
      if (elementFound && !textMatches) {
        if (opts?.edits) {
          const tagPattern = new RegExp(`<${p.selector}[^>]*>[^<]*</${p.selector}>`, "gi");
          let editFixesText = false;
          for (const edit of opts.edits) {
            const match = tagPattern.exec(edit.replace);
            if (match && match[0].includes(p.expected)) {
              editFixesText = true;
              break;
            }
            tagPattern.lastIndex = 0;
          }
          if (!editFixesText) {
            return { ...p, groundingMiss: true, groundingReason: `HTML element "${p.selector}" exists but does not contain text "${p.expected}" and no edit changes it to match` };
          }
        } else {
          return { ...p, groundingMiss: true, groundingReason: `HTML element "${p.selector}" exists but does not contain text "${p.expected}"` };
        }
      }
      if (!elementFound) {
        if (p.path) {
          const otherRoutes = [...grounding.htmlElements.keys()].filter((r) => r !== p.path);
          for (const route of otherRoutes) {
            const elements = grounding.htmlElements.get(route) ?? [];
            if (elements.some((el) => el.tag === p.selector)) {
              return { ...p, groundingMiss: true, groundingReason: `HTML element "${p.selector}" exists on route "${route}" but not on claimed route "${p.path}"` };
            }
          }
        }
        if (opts?.edits && p.expected) {
          const tagPattern = new RegExp(`<${p.selector}[^>]*>([^<]*)</${p.selector}>`, "i");
          let editCreates = false;
          for (const edit of opts.edits) {
            const match = tagPattern.exec(edit.replace);
            if (match) {
              editCreates = true;
              const editText = match[1].trim();
              if (editText && !editText.includes(p.expected)) {
                return { ...p, groundingMiss: true, groundingReason: `Edit creates <${p.selector}> with text "${editText}" but predicate expects "${p.expected}"` };
              }
            }
          }
          if (!editCreates) {
            return { ...p, groundingMiss: true, groundingReason: `HTML element "${p.selector}" not found in app source and no edit creates it` };
          }
        } else if (!opts?.edits) {
          return { ...p, groundingMiss: true, groundingReason: `HTML element "${p.selector}" not found in app source` };
        }
      }
    }
    if (p.type === "content" && p.file && p.pattern && opts?.appDir) {
      try {
        const filePath = (0, import_path4.join)(opts.appDir, p.file);
        if ((0, import_fs4.existsSync)(filePath)) {
          const content = (0, import_fs4.readFileSync)(filePath, "utf-8").replace(/\r\n/g, "\n");
          const normalizedPattern = p.pattern.replace(/\r\n/g, "\n");
          if (!content.includes(normalizedPattern)) {
            const editsWouldCreate = opts.edits?.some(
              (e) => e.file === p.file && e.replace.replace(/\r\n/g, "\n").includes(normalizedPattern)
            );
            if (!editsWouldCreate) {
              return { ...p, groundingMiss: true, groundingReason: `Pattern "${p.pattern}" not found in file "${p.file}" and no edit would create it` };
            }
          } else {
            const fileEdits = opts.edits?.filter((e) => e.file === p.file) ?? [];
            if (fileEdits.length > 0) {
              let postEdit = content;
              for (const e of fileEdits) {
                const normalizedSearch = e.search.replace(/\r\n/g, "\n");
                if (postEdit.includes(normalizedSearch)) {
                  postEdit = postEdit.replace(normalizedSearch, e.replace.replace(/\r\n/g, "\n"));
                }
              }
              if (!postEdit.includes(normalizedPattern)) {
                return { ...p, groundingMiss: true, groundingReason: `Edit removes "${p.pattern}" from "${p.file}" \u2014 post-edit content no longer matches predicate` };
              }
            }
          }
        } else {
          const editCreatesFile = opts.edits?.some((e) => e.file === p.file);
          if (!editCreatesFile) {
            return { ...p, groundingMiss: true, groundingReason: `File "${p.file}" does not exist in app directory` };
          }
          const normalizedPattern = p.pattern.replace(/\r\n/g, "\n");
          const fileEdits = opts.edits?.filter((e) => e.file === p.file) ?? [];
          const postEditContent = fileEdits.map((e) => e.replace.replace(/\r\n/g, "\n")).join("\n");
          if (postEditContent && !postEditContent.includes(normalizedPattern)) {
            return { ...p, groundingMiss: true, groundingReason: `New file "${p.file}" will not contain pattern "${p.pattern}" after edit` };
          }
        }
      } catch {
      }
    }
    if (p.type === "filesystem_exists" || p.type === "filesystem_absent" || p.type === "filesystem_unchanged" || p.type === "filesystem_count") {
      const filePath = p.file ?? p.path;
      if (!filePath) {
        return { ...p, groundingMiss: true, groundingReason: `Filesystem predicate missing file/path field` };
      }
      if (opts?.appDir) {
        const fullPath = (0, import_path4.join)(opts.appDir, filePath);
        if (p.type === "filesystem_exists") {
        }
        if (p.type === "filesystem_absent") {
          if (!(0, import_fs4.existsSync)(fullPath)) {
            return { ...p, groundingMiss: true, groundingReason: `Path "${filePath}" already absent \u2014 predicate is trivially true` };
          }
        }
        if (p.type === "filesystem_unchanged") {
          if (!p.hash) {
            return { ...p, groundingMiss: true, groundingReason: `filesystem_unchanged requires a hash field captured at grounding time` };
          }
          if (!(0, import_fs4.existsSync)(fullPath)) {
            return { ...p, groundingMiss: true, groundingReason: `Path "${filePath}" does not exist \u2014 cannot verify unchanged` };
          }
        }
        if (p.type === "filesystem_count") {
          if (p.count == null) {
            return { ...p, groundingMiss: true, groundingReason: `filesystem_count requires a count field` };
          }
        }
      }
    }
    if (p.type === "http" && opts?.appDir && !opts?.appUrl) {
      const claimedContent = [];
      if (p.expect?.bodyContains) {
        if (Array.isArray(p.expect.bodyContains)) {
          claimedContent.push(...p.expect.bodyContains);
        } else {
          claimedContent.push(p.expect.bodyContains);
        }
      }
      if (p.expected && p.expected !== "exists") {
        claimedContent.push(p.expected);
      }
      if (claimedContent.length > 0) {
        const sourceFiles = findSourceFiles(opts.appDir);
        const allSource = sourceFiles.map((f) => {
          try {
            return (0, import_fs4.readFileSync)(f, "utf-8");
          } catch {
            return "";
          }
        }).join("\n");
        for (const claim of claimedContent) {
          if (!allSource.includes(claim)) {
            let editAddsContent = false;
            if (opts?.edits) {
              for (const edit of opts.edits) {
                if (edit.replace && edit.replace.includes(claim)) {
                  editAddsContent = true;
                  break;
                }
              }
            }
            if (!editAddsContent) {
              return { ...p, groundingMiss: true, groundingReason: `HTTP body content "${claim}" not found in any app source file` };
            }
          }
        }
      }
    }
    if (p.type === "db" && grounding.dbSchema && grounding.dbSchema.length > 0) {
      const assertion = p.assertion;
      const tableName = p.table;
      const columnName = p.column;
      if (tableName && assertion) {
        const tableEntry = grounding.dbSchema.find(
          (t) => t.table.toLowerCase() === tableName.toLowerCase()
        );
        const editIntroduces = (name) => {
          if (!opts?.edits) return false;
          const lower = name.toLowerCase();
          return opts.edits.some(
            (e) => e.replace && e.replace.toLowerCase().includes(lower) && (!e.search || !e.search.toLowerCase().includes(lower))
          );
        };
        if (assertion === "table_exists") {
          if (!tableEntry) {
            if (!editIntroduces(`CREATE TABLE ${tableName}`) && !editIntroduces(`create table ${tableName}`)) {
              return { ...p, groundingMiss: true, groundingReason: `Table "${tableName}" not found in init.sql schema` };
            }
          }
        }
        if (assertion === "column_exists" && columnName) {
          if (!tableEntry) {
            if (!editIntroduces(`CREATE TABLE ${tableName}`) && !editIntroduces(`create table ${tableName}`)) {
              return { ...p, groundingMiss: true, groundingReason: `Table "${tableName}" not found in init.sql schema (checking column "${columnName}")` };
            }
          } else {
            const colEntry = tableEntry.columns.find(
              (c) => c.name.toLowerCase() === columnName.toLowerCase()
            );
            if (!colEntry) {
              if (!editIntroduces(columnName)) {
                return { ...p, groundingMiss: true, groundingReason: `Column "${columnName}" not found in table "${tableName}"` };
              }
            }
          }
        }
        if (assertion === "column_type" && columnName && p.expected) {
          if (!tableEntry) {
            if (!editIntroduces(`CREATE TABLE ${tableName}`) && !editIntroduces(`create table ${tableName}`)) {
              return { ...p, groundingMiss: true, groundingReason: `Table "${tableName}" not found in init.sql schema (checking column type)` };
            }
          } else {
            const colEntry = tableEntry.columns.find(
              (c) => c.name.toLowerCase() === columnName.toLowerCase()
            );
            if (!colEntry) {
              if (!editIntroduces(columnName)) {
                return { ...p, groundingMiss: true, groundingReason: `Column "${columnName}" not found in table "${tableName}" (checking type)` };
              }
            } else {
              const actualNorm = normalizeDBType(colEntry.type);
              const expectedNorm = normalizeDBType(p.expected);
              if (actualNorm !== expectedNorm) {
                if (!editIntroduces(p.expected)) {
                  return { ...p, groundingMiss: true, groundingReason: `Column "${tableName}.${columnName}" type is "${colEntry.type}" (normalized: "${actualNorm}") but predicate claims "${p.expected}" (normalized: "${expectedNorm}")` };
                }
              }
            }
          }
        }
      }
    }
    if (p.type === "infra_resource" && grounding.infraState && grounding.infraState.resources.length > 0) {
      const resourceAddr = p.resource;
      if (resourceAddr) {
        const found = grounding.infraState.resources.some((r) => r.address === resourceAddr);
        const assertion = p.assertion ?? "exists";
        if (assertion === "exists" && !found) {
          return { ...p, groundingMiss: true, groundingReason: `Resource "${resourceAddr}" not found in infrastructure state file` };
        }
      }
    }
    if (p.type === "infra_attribute" && grounding.infraState && grounding.infraState.resources.length > 0) {
      const resourceAddr = p.resource;
      const attribute = p.attribute;
      if (resourceAddr) {
        const found = grounding.infraState.resources.some((r) => r.address === resourceAddr);
        if (!found) {
          return { ...p, groundingMiss: true, groundingReason: `Resource "${resourceAddr}" not found in infrastructure state file (checking attribute "${attribute}")` };
        }
      }
    }
    return p;
  });
}
function findSourceFiles(dir, maxDepth = 3, depth = 0) {
  if (depth > maxDepth) return [];
  const files = [];
  const SKIP = /* @__PURE__ */ new Set(["node_modules", ".git", ".next", "dist", "build", ".sovereign", ".verify", ".verify-tmp"]);
  try {
    const entries = (0, import_fs4.readdirSync)(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const fullPath = (0, import_path4.join)(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findSourceFiles(fullPath, maxDepth, depth + 1));
      } else {
        const ext = (0, import_path4.extname)(entry.name).toLowerCase();
        if ([".js", ".ts", ".jsx", ".tsx", ".html", ".css", ".vue", ".svelte", ".php", ".rb", ".py", ".sql"].includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  } catch {
  }
  return files;
}
function extractRouteBlocks(content) {
  const blocks = /* @__PURE__ */ new Map();
  const vanillaPattern = /(?:url\.pathname|req\.url)\s*===?\s*['"`]([^'"`]+)['"`]/g;
  const expressPattern = /app\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  const routeStarts = [];
  let match;
  while ((match = vanillaPattern.exec(content)) !== null) {
    routeStarts.push({ route: match[1], index: match.index });
  }
  while ((match = expressPattern.exec(content)) !== null) {
    routeStarts.push({ route: match[2], index: match.index });
  }
  routeStarts.sort((a, b) => a.index - b.index);
  for (let i = 0; i < routeStarts.length; i++) {
    const start = routeStarts[i].index;
    const end = i + 1 < routeStarts.length ? routeStarts[i + 1].index : content.length;
    const block = content.slice(start, end);
    if (block.includes("<style") || block.includes("<html") || block.includes("text/html")) {
      blocks.set(routeStarts[i].route, block);
    }
  }
  return blocks;
}
function extractRoutes(content) {
  const routes = [];
  const expressPattern = /app\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  let match;
  while ((match = expressPattern.exec(content)) !== null) {
    routes.push(match[2]);
  }
  const vanillaPattern = /(?:url\.pathname|req\.url)\s*===?\s*['"`]([^'"`]+)['"`]/gi;
  while ((match = vanillaPattern.exec(content)) !== null) {
    routes.push(match[1]);
  }
  return routes;
}
function extractCSS(content) {
  const rules = /* @__PURE__ */ new Map();
  const styleBlockPattern = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  const cssLiteralPattern = /`([^`]*\{[^`]*\}[^`]*)`/g;
  const cssBlocks = [];
  let match;
  while ((match = styleBlockPattern.exec(content)) !== null) {
    cssBlocks.push(match[1]);
  }
  if (content.includes("`")) {
    while ((match = cssLiteralPattern.exec(content)) !== null) {
      if (match[1].includes("{") && match[1].includes(":")) {
        cssBlocks.push(match[1]);
      }
    }
  }
  for (const block of cssBlocks) {
    const rulePattern = /([^{}]+)\{([^{}]+)\}/g;
    while ((match = rulePattern.exec(block)) !== null) {
      const selector = match[1].trim();
      const body = match[2];
      if (selector.startsWith("@")) continue;
      const props = {};
      const propPattern = /([a-z-]+)\s*:\s*([^;]+)/gi;
      let propMatch;
      while ((propMatch = propPattern.exec(body)) !== null) {
        props[propMatch[1].trim()] = propMatch[2].trim();
      }
      const existing = rules.get(selector) ?? {};
      rules.set(selector, { ...existing, ...props });
    }
  }
  return rules;
}
function extractHTMLElements(content) {
  const elements = [];
  const tagPattern = /<([\w-]+)([^>]*)>([^<]*)<\/\1>/g;
  let match;
  while ((match = tagPattern.exec(content)) !== null) {
    const tag = match[1];
    const attrString = match[2];
    const text = match[3].trim();
    if (["div", "span", "section", "main", "head", "body", "html", "script", "style"].includes(tag)) continue;
    const attributes = {};
    const attrPattern = /([\w-]+)=["']([^"']+)["']/g;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(attrString)) !== null) {
      attributes[attrMatch[1]] = attrMatch[2];
    }
    elements.push({
      tag,
      text: text || void 0,
      attributes: Object.keys(attributes).length > 0 ? attributes : void 0
    });
  }
  return elements;
}
var _NC = { black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", navy: "#000080", orange: "#ffa500", yellow: "#ffff00", purple: "#800080", gray: "#808080", grey: "#808080", silver: "#c0c0c0", maroon: "#800000", teal: "#008080", cyan: "#00ffff", coral: "#ff7f50", tomato: "#ff6347", gold: "#ffd700", indigo: "#4b0082", crimson: "#dc143c", salmon: "#fa8072", lime: "#00ff00", aqua: "#00ffff", pink: "#ffc0cb", olive: "#808000", fuchsia: "#ff00ff", violet: "#ee82ee" };
function _nC(v, property) {
  const l = v.trim().toLowerCase();
  if (property === "font-weight" || !property) {
    if (l === "normal" || l === "400") return "400";
    if (l === "bold" || l === "700") return "700";
  }
  if (_NC[l]) return _NC[l];
  if (/^0(?:px|em|rem|%|pt|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pc)$/.test(l)) return "0";
  if (/^(?:rgb|hsl)a?\s*\(/.test(l)) {
    const norm = l.replace(/\s+/g, "").replace(/,\s*/g, ",");
    const rgbaM = norm.match(/^rgba\((\d+),(\d+),(\d+),(1(?:\.0*)?)\)$/);
    if (rgbaM) return _rgbToHex(+rgbaM[1], +rgbaM[2], +rgbaM[3]);
    const hslaM = norm.match(/^hsla\(([\d.]+),([\d.]+)%,([\d.]+)%,(1(?:\.0*)?)\)$/);
    if (hslaM) return _hslToHex(+hslaM[1], +hslaM[2], +hslaM[3]);
    const rgbM = norm.match(/^rgb\((\d+),(\d+),(\d+)\)$/);
    if (rgbM) return _rgbToHex(+rgbM[1], +rgbM[2], +rgbM[3]);
    const hslM = norm.match(/^hsl\(([\d.]+),([\d.]+)%,([\d.]+)%\)$/);
    if (hslM) return _hslToHex(+hslM[1], +hslM[2], +hslM[3]);
    return norm;
  }
  return l;
}
function _rgbToHex(r, g, b) {
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
  return "#" + [clamp(r), clamp(g), clamp(b)].map((c) => c.toString(16).padStart(2, "0")).join("");
}
function _hslToHex(h, s, l) {
  const s1 = s / 100, l1 = l / 100;
  const c = (1 - Math.abs(2 * l1 - 1)) * s1;
  const x = c * (1 - Math.abs(h / 60 % 2 - 1));
  const m = l1 - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return _rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}
var _SH = { border: ["border-width", "border-style", "border-color"], "border-top": ["border-top-width", "border-top-style", "border-top-color"], "border-right": ["border-right-width", "border-right-style", "border-right-color"], "border-bottom": ["border-bottom-width", "border-bottom-style", "border-bottom-color"], "border-left": ["border-left-width", "border-left-style", "border-left-color"], margin: ["margin-top", "margin-right", "margin-bottom", "margin-left"], padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"], background: ["background-color"], font: ["font-style", "font-variant", "font-weight", "font-size", "line-height", "font-family"], outline: ["outline-width", "outline-style", "outline-color"], flex: ["flex-grow", "flex-shrink", "flex-basis"], overflow: ["overflow-x", "overflow-y"] };
var _SH_EDIT_ONLY = { transition: ["transition-property", "transition-duration", "transition-timing-function", "transition-delay"], animation: ["animation-name", "animation-duration", "animation-timing-function", "animation-delay", "animation-iteration-count", "animation-direction", "animation-fill-mode", "animation-play-state"], "grid-template": ["grid-template-rows", "grid-template-columns"] };
function _stripVendor(prop) {
  const m = prop.match(/^-(?:webkit|moz|ms|o)-(.+)$/);
  return m ? m[1] : void 0;
}
function _rS(sp, sv, lp) {
  const ls = _SH[sp];
  if (!ls) return;
  const i = ls.indexOf(lp);
  if (i === -1) return;
  const t = sv.trim().split(/\s+/);
  return t[i];
}
var DB_TYPE_ALIASES = {
  "serial": "integer",
  "bigserial": "bigint",
  "smallserial": "smallint",
  "int": "integer",
  "int4": "integer",
  "int8": "bigint",
  "int2": "smallint",
  "bool": "boolean",
  "character varying": "varchar",
  "character": "char",
  "double precision": "double",
  "float4": "real",
  "float8": "double",
  "timestamptz": "timestamp with time zone",
  "timetz": "time with time zone"
};
function normalizeDBType(raw) {
  let t = raw.trim().toLowerCase();
  t = t.replace(/\s*\([^)]*\)/, "");
  return DB_TYPE_ALIASES[t] ?? t;
}
function parseInitSQL(sql) {
  const tables = [];
  const clean = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const tablePattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?\s*\(([\s\S]*?)\)\s*;/gi;
  let tableMatch;
  while ((tableMatch = tablePattern.exec(clean)) !== null) {
    const tableName = tableMatch[1];
    const body = tableMatch[2];
    const columns = [];
    const parts = [];
    let depth = 0;
    let current = "";
    for (const ch of body) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) {
        parts.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    for (const part of parts) {
      const trimmed = part.trim();
      if (/^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(trimmed)) continue;
      const colMatch = trimmed.match(/^["']?(\w+)["']?\s+(\w+(?:\s*\([^)]*\))?(?:\s+(?:varying|precision|with(?:out)?\s+time\s+zone))?)/i);
      if (colMatch) {
        const colName = colMatch[1];
        const rawType = colMatch[2];
        const nullable = !/NOT\s+NULL/i.test(trimmed);
        const hasDefault = /DEFAULT\b/i.test(trimmed);
        columns.push({ name: colName, type: rawType, nullable, hasDefault });
      }
    }
    if (columns.length > 0) {
      tables.push({ table: tableName, columns });
    }
  }
  return tables;
}
function findAndParseSchema(appDir) {
  const candidates = [
    (0, import_path4.join)(appDir, "init.sql"),
    (0, import_path4.join)(appDir, "db", "init.sql"),
    (0, import_path4.join)(appDir, "sql", "init.sql"),
    (0, import_path4.join)(appDir, "schema.sql")
  ];
  for (const candidate of candidates) {
    if ((0, import_fs4.existsSync)(candidate)) {
      try {
        const sql = (0, import_fs4.readFileSync)(candidate, "utf-8");
        const parsed = parseInitSQL(sql);
        if (parsed.length > 0) return parsed;
      } catch {
      }
    }
  }
  return void 0;
}
function extractClassTokens(content, route) {
  const tokens = /* @__PURE__ */ new Set();
  const classPattern = /class=["']([^"']+)["']/g;
  let match;
  while ((match = classPattern.exec(content)) !== null) {
    for (const token of match[1].split(/\s+/)) {
      if (token.length > 0) tokens.add(token);
    }
  }
  return tokens;
}

// src/gates/hallucination.ts
function runHallucinationGate(ctx) {
  const start = Date.now();
  const { predicates, config, log } = ctx;
  const appDir = ctx.stageDir ?? config.appDir;
  const halPreds = predicates.filter((p) => p.type === "hallucination");
  if (halPreds.length === 0) {
    return { gate: "hallucination", passed: true, detail: "No hallucination predicates", durationMs: Date.now() - start };
  }
  const failures = [];
  for (const pred of halPreds) {
    if (!pred.claim) {
      failures.push("Missing claim field on hallucination predicate");
      continue;
    }
    if (!pred.source) {
      failures.push(`Missing source field for claim: "${pred.claim}"`);
      continue;
    }
    if (!pred.halAssert || pred.halAssert !== "grounded" && pred.halAssert !== "fabricated") {
      failures.push(`Invalid halAssert for claim: "${pred.claim}" (must be 'grounded' or 'fabricated')`);
      continue;
    }
    const claimExists = checkClaim(pred.claim, pred.source, appDir);
    if (pred.halAssert === "grounded" && !claimExists) {
      failures.push(`Claim NOT grounded: "${pred.claim}" (source: ${pred.source}) \u2014 claim not found in source`);
    } else if (pred.halAssert === "fabricated" && claimExists) {
      failures.push(`Claim NOT fabricated: "${pred.claim}" (source: ${pred.source}) \u2014 claim exists but was expected to be fabricated`);
    }
  }
  if (failures.length > 0) {
    const detail = `${failures.length} hallucination check(s) failed:
${failures.map((f) => `  - ${f}`).join("\n")}`;
    log(`[hallucination] FAILED: ${detail}`);
    return { gate: "hallucination", passed: false, detail, durationMs: Date.now() - start };
  }
  return {
    gate: "hallucination",
    passed: true,
    detail: `${halPreds.length} hallucination claim(s) verified`,
    durationMs: Date.now() - start
  };
}
function checkClaim(claim, source, appDir) {
  switch (source) {
    case "schema":
      return checkSchemaClaim(claim, appDir);
    case "routes":
      return checkRouteClaim(claim, appDir);
    case "css":
      return checkCSSClaim(claim, appDir);
    case "config":
      return checkConfigClaim(claim, appDir);
    case "files":
      return checkFileExistenceClaim(claim, appDir);
    case "content":
      return checkContentClaim(claim, appDir);
    default:
      return checkFileContentClaim(claim, source, appDir);
  }
}
function checkSchemaClaim(claim, appDir) {
  const schema = loadSchema(appDir);
  if (!schema || schema.length === 0) return false;
  const lower = claim.toLowerCase();
  const tableExistsMatch = lower.match(/(\w+)\s+table\s+(?:exists|has|is)/i) ?? lower.match(/table\s+(\w+)/i);
  if (tableExistsMatch) {
    const tableName = tableExistsMatch[1];
    if (/exists/i.test(lower) && !/column|has\s+\w+\s+column/i.test(lower)) {
      return schema.some((t) => t.table.toLowerCase() === tableName);
    }
  }
  const colMatch = lower.match(/(\w+)\s+table\s+has\s+(\w+)\s+column/i) ?? lower.match(/(\w+)\.(\w+)/i) ?? lower.match(/(\w+)\s+has\s+(\w+)/i);
  if (colMatch) {
    const tableName = colMatch[1];
    const colName = colMatch[2];
    const table = schema.find((t) => t.table.toLowerCase() === tableName);
    if (!table) return false;
    return table.columns.some((c) => c.name.toLowerCase() === colName);
  }
  const typeMatch = lower.match(/(\w+)\s+column\s+type\s+is\s+(\w+)/i) ?? lower.match(/(\w+)\s+(?:is\s+(?:type\s+)?|has\s+type\s+|type\s+is\s+)(\w+)/i);
  if (typeMatch) {
    const colName = typeMatch[1];
    const expectedType = typeMatch[2];
    for (const table of schema) {
      const col = table.columns.find((c) => c.name.toLowerCase() === colName);
      if (col && col.type.toLowerCase().startsWith(expectedType.toLowerCase())) {
        return true;
      }
    }
    return false;
  }
  if (/foreign\s*key|references/i.test(lower)) {
    const rawSQL = loadRawSQL(appDir);
    if (!rawSQL) return false;
    return rawSQL.toLowerCase().includes(claim.toLowerCase().replace(/\s+/g, " "));
  }
  const words = lower.split(/\s+/);
  for (const table of schema) {
    if (words.includes(table.table.toLowerCase())) return true;
    for (const col of table.columns) {
      if (words.includes(col.name.toLowerCase())) return true;
    }
  }
  return false;
}
function checkRouteClaim(claim, appDir) {
  const content = loadServerContent(appDir);
  if (!content) return false;
  const routes = extractRoutes2(content);
  const routeMatch = claim.match(/(GET|POST|PUT|DELETE|PATCH)?\s*(\/[\w/.-]*)/i);
  if (routeMatch) {
    const method = routeMatch[1]?.toUpperCase();
    const path = routeMatch[2];
    const routeExists = routes.some((r) => r.path === path);
    if (!routeExists) return false;
    if (method) {
      return routes.some((r) => r.path === path && r.method.toUpperCase() === method);
    }
    return true;
  }
  return content.toLowerCase().includes(claim.toLowerCase());
}
function checkCSSClaim(claim, appDir) {
  const content = loadServerContent(appDir);
  if (!content) return false;
  const cssRules = extractCSS2(content);
  const selectorMatch = claim.match(/\.?([\w.-]+(?:\s+[\w.-]+)?)\s+(?:has\s+|)(\w[\w-]*)\s*(?:is\s+|=\s*|:\s*)([\w#%().,\s-]+)/i) ?? claim.match(/selector\s+\.?([\w.-]+)/i);
  if (selectorMatch && selectorMatch[2]) {
    const selector = selectorMatch[1].startsWith(".") ? selectorMatch[1] : `.${selectorMatch[1]}`;
    const property = selectorMatch[2];
    const value = selectorMatch[3]?.trim();
    let rules;
    rules = cssRules.get(selector);
    if (!rules) {
      for (const [key, val] of cssRules.entries()) {
        if (key.includes(selector)) {
          rules = val;
          break;
        }
      }
    }
    if (!rules) return false;
    if (!property) return true;
    if (!value) return property in rules;
    return rules[property]?.toLowerCase() === value.toLowerCase();
  }
  const justSelector = claim.match(/\.?([\w-]+)\s+(?:exists|selector|class)/i);
  if (justSelector) {
    const sel = justSelector[1].startsWith(".") ? justSelector[1] : `.${justSelector[1]}`;
    for (const key of cssRules.keys()) {
      if (key === sel || key.includes(sel)) return true;
    }
    return false;
  }
  return false;
}
function checkConfigClaim(claim, appDir) {
  const config = loadConfig(appDir);
  if (!config) return false;
  const keyMatch = claim.match(/([\w.]+)\s+(?:exists|is\s+|=\s*|has\s+value\s+)(.*)?/i) ?? claim.match(/([\w.]+)/);
  if (!keyMatch) return false;
  const keyPath = keyMatch[1];
  const expectedValue = keyMatch[2]?.trim();
  const actual = resolveKeyPath(config, keyPath);
  if (actual === void 0) return false;
  if (!expectedValue || /exists/i.test(claim)) return true;
  return String(actual).toLowerCase() === expectedValue.toLowerCase();
}
function checkFileExistenceClaim(claim, appDir) {
  const pathMatch = claim.match(/([\w/.-]+\.\w+)/);
  if (pathMatch) {
    const filePath = (0, import_path5.join)(appDir, pathMatch[1]);
    return (0, import_fs5.existsSync)(filePath);
  }
  const dirMatch = claim.match(/([\w/.-]+\/)/);
  if (dirMatch) {
    const dirPath = (0, import_path5.join)(appDir, dirMatch[1]);
    return (0, import_fs5.existsSync)(dirPath);
  }
  return false;
}
function checkContentClaim(claim, appDir) {
  const sourceFiles = findSourceFiles2(appDir);
  const lower = claim.toLowerCase();
  for (const file of sourceFiles) {
    try {
      const content = (0, import_fs5.readFileSync)(file, "utf-8").toLowerCase();
      if (content.includes(lower)) return true;
    } catch {
    }
  }
  return false;
}
function checkFileContentClaim(claim, filePath, appDir) {
  const fullPath = (0, import_path5.join)(appDir, filePath);
  if (!(0, import_fs5.existsSync)(fullPath)) return false;
  try {
    const content = (0, import_fs5.readFileSync)(fullPath, "utf-8");
    return content.toLowerCase().includes(claim.toLowerCase());
  } catch {
    return false;
  }
}
function loadSchema(appDir) {
  const candidates = [
    (0, import_path5.join)(appDir, "init.sql"),
    (0, import_path5.join)(appDir, "db", "init.sql"),
    (0, import_path5.join)(appDir, "sql", "init.sql"),
    (0, import_path5.join)(appDir, "schema.sql")
  ];
  for (const candidate of candidates) {
    if ((0, import_fs5.existsSync)(candidate)) {
      try {
        const sql = (0, import_fs5.readFileSync)(candidate, "utf-8");
        const parsed = parseInitSQL(sql);
        if (parsed.length > 0) return parsed;
      } catch {
      }
    }
  }
  return null;
}
function loadRawSQL(appDir) {
  const candidates = [
    (0, import_path5.join)(appDir, "init.sql"),
    (0, import_path5.join)(appDir, "db", "init.sql"),
    (0, import_path5.join)(appDir, "sql", "init.sql"),
    (0, import_path5.join)(appDir, "schema.sql")
  ];
  for (const candidate of candidates) {
    if ((0, import_fs5.existsSync)(candidate)) {
      try {
        return (0, import_fs5.readFileSync)(candidate, "utf-8");
      } catch {
      }
    }
  }
  return null;
}
function loadServerContent(appDir) {
  const candidates = [
    (0, import_path5.join)(appDir, "server.js"),
    (0, import_path5.join)(appDir, "server.ts"),
    (0, import_path5.join)(appDir, "app.js"),
    (0, import_path5.join)(appDir, "app.ts"),
    (0, import_path5.join)(appDir, "index.js"),
    (0, import_path5.join)(appDir, "index.ts"),
    (0, import_path5.join)(appDir, "src", "server.js"),
    (0, import_path5.join)(appDir, "src", "server.ts"),
    (0, import_path5.join)(appDir, "src", "index.js"),
    (0, import_path5.join)(appDir, "src", "index.ts")
  ];
  for (const candidate of candidates) {
    if ((0, import_fs5.existsSync)(candidate)) {
      try {
        return (0, import_fs5.readFileSync)(candidate, "utf-8");
      } catch {
      }
    }
  }
  return null;
}
function loadConfig(appDir) {
  const candidates = [
    (0, import_path5.join)(appDir, "config.json"),
    (0, import_path5.join)(appDir, "config.js"),
    (0, import_path5.join)(appDir, "settings.json")
  ];
  for (const candidate of candidates) {
    if ((0, import_fs5.existsSync)(candidate) && (0, import_path5.extname)(candidate) === ".json") {
      try {
        return JSON.parse((0, import_fs5.readFileSync)(candidate, "utf-8"));
      } catch {
      }
    }
  }
  return null;
}
function resolveKeyPath(obj, path) {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current === null || current === void 0 || typeof current !== "object") return void 0;
    current = current[part];
  }
  return current;
}
function findSourceFiles2(appDir) {
  const files = [];
  const sourceExts = /* @__PURE__ */ new Set([".js", ".ts", ".jsx", ".tsx", ".sql", ".json", ".html", ".css"]);
  try {
    const entries = (0, import_fs5.readdirSync)(appDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = (0, import_path5.join)(appDir, entry.name);
      if (entry.isFile() && sourceExts.has((0, import_path5.extname)(entry.name))) {
        files.push(fullPath);
      }
    }
  } catch {
  }
  return files;
}
function extractRoutes2(content) {
  const routes = [];
  const expressPattern = /app\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  let match;
  while ((match = expressPattern.exec(content)) !== null) {
    routes.push({ method: match[1].toUpperCase(), path: match[2] });
  }
  const vanillaPattern = /(?:req\.url|url\.pathname)\s*===?\s*['"`]([^'"`]+)['"`]/gi;
  while ((match = vanillaPattern.exec(content)) !== null) {
    const method = inferMethod(content, match.index);
    routes.push({ method, path: match[1] });
  }
  return routes;
}
function inferMethod(content, matchIndex) {
  const before = content.slice(Math.max(0, matchIndex - 200), matchIndex);
  const methodMatch = before.match(/req\.method\s*===?\s*['"`](GET|POST|PUT|DELETE|PATCH)['"`]/i);
  return methodMatch ? methodMatch[1].toUpperCase() : "GET";
}
function extractCSS2(content) {
  const rules = /* @__PURE__ */ new Map();
  const styleBlockPattern = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  const cssBlocks = [];
  let match;
  while ((match = styleBlockPattern.exec(content)) !== null) {
    cssBlocks.push(match[1]);
  }
  for (const block of cssBlocks) {
    const rulePattern = /([^{}]+)\{([^{}]+)\}/g;
    while ((match = rulePattern.exec(block)) !== null) {
      const selector = match[1].trim();
      if (selector.startsWith("@")) continue;
      const props = {};
      const propPattern = /([a-z-]+)\s*:\s*([^;]+)/gi;
      let propMatch;
      while ((propMatch = propPattern.exec(match[2])) !== null) {
        props[propMatch[1].trim()] = propMatch[2].trim();
      }
      const existing = rules.get(selector) ?? {};
      rules.set(selector, { ...existing, ...props });
    }
  }
  return rules;
}

// src/gates/staging.ts
async function runStagingGate(ctx, runner) {
  const start = Date.now();
  const needsFullRebuild = ctx.edits.some((e) => isBuildLayerFile(e.file));
  ctx.log(`[staging] Building container${needsFullRebuild ? " (full rebuild \u2014 dependency file changed)" : " (cached)"}...`);
  const buildResult2 = await runner.build({ noCache: needsFullRebuild });
  if (buildResult2.exitCode !== 0) {
    return {
      gate: "staging",
      passed: false,
      detail: `Docker build failed: ${buildResult2.stderr.substring(0, 200)}`,
      durationMs: Date.now() - start,
      logs: buildResult2.stderr
    };
  }
  ctx.log("[staging] Starting container...");
  const startResult = await runner.start();
  if (startResult.exitCode !== 0) {
    return {
      gate: "staging",
      passed: false,
      detail: `Container failed to start: ${startResult.stderr.substring(0, 200)}`,
      durationMs: Date.now() - start,
      logs: startResult.stderr
    };
  }
  ctx.log(`[staging] Container healthy at ${runner.getAppUrl()}`);
  return {
    gate: "staging",
    passed: true,
    detail: `Container built and healthy at ${runner.getAppUrl()}`,
    durationMs: Date.now() - start
  };
}
var BUILD_LAYER_FILES = /* @__PURE__ */ new Set([
  "package.json",
  "package-lock.json",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  "requirements.txt",
  "pipfile",
  "pipfile.lock",
  "pyproject.toml",
  "poetry.lock",
  "go.mod",
  "go.sum",
  "gemfile",
  "gemfile.lock",
  "cargo.toml",
  "cargo.lock",
  "composer.json",
  "composer.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "dockerfile",
  ".dockerignore",
  "docker-compose.yml",
  "docker-compose.yaml"
]);
function isBuildLayerFile(file) {
  const basename4 = file.split("/").pop()?.toLowerCase() ?? "";
  return BUILD_LAYER_FILES.has(basename4);
}

// src/gates/browser.ts
var import_fs6 = require("fs");
var import_path6 = require("path");
var import_child_process = require("child_process");
var PLAYWRIGHT_IMAGE = "verify-playwright:latest";
var PER_PATH_TIMEOUT = 1e4;
var TOTAL_TIMEOUT = 3e4;
async function runBrowserGate(ctx) {
  const start = Date.now();
  const browserPredicates = ctx.predicates.filter(
    (p) => p.type === "css" || p.type === "html"
  );
  if (browserPredicates.length === 0) {
    return {
      gate: "browser",
      passed: true,
      detail: "No CSS/HTML predicates to check",
      durationMs: Date.now() - start,
      results: []
    };
  }
  if (!ctx.appUrl) {
    return {
      gate: "browser",
      passed: false,
      detail: "No app URL available \u2014 staging gate must run first",
      durationMs: Date.now() - start,
      results: []
    };
  }
  const hasPlaywright = await checkPlaywrightImage();
  if (!hasPlaywright) {
    ctx.log("[browser] Playwright image not available \u2014 skipping browser gate");
    return {
      gate: "browser",
      passed: true,
      detail: "Playwright image not available \u2014 build with: docker build -t verify-playwright:latest (see docs)",
      durationMs: Date.now() - start,
      results: []
    };
  }
  const pathGroups = /* @__PURE__ */ new Map();
  for (const p of browserPredicates) {
    const path = p.path ?? "/";
    if (!pathGroups.has(path)) pathGroups.set(path, []);
    pathGroups.get(path).push(p);
  }
  const paths = [...pathGroups.keys()].slice(0, 3);
  const workDir = (0, import_path6.join)(ctx.config.appDir, ".verify-tmp");
  (0, import_fs6.mkdirSync)(workDir, { recursive: true });
  const input = {
    baseUrl: ctx.appUrl,
    paths: paths.map((path) => ({
      path,
      predicates: (pathGroups.get(path) ?? []).map((p, i) => ({
        id: `p${i}`,
        type: p.type,
        selector: p.selector,
        property: p.property,
        // Map expected → operator + value for the runner
        operator: !p.expected || p.expected === "exists" ? "exists" : "==",
        value: p.expected === "exists" ? void 0 : p.expected,
        expected: p.expected
      }))
    })),
    timeout: PER_PATH_TIMEOUT
  };
  const inputPath = (0, import_path6.join)(workDir, "browser-gate-input.json");
  const resultsPath = (0, import_path6.join)(workDir, "browser-gate-results.json");
  (0, import_fs6.writeFileSync)(inputPath, JSON.stringify(input, null, 2));
  const runnerPath = findBrowserGateRunner();
  if (!runnerPath) {
    return {
      gate: "browser",
      passed: true,
      detail: "Browser gate runner not found \u2014 gate skipped",
      durationMs: Date.now() - start,
      results: []
    };
  }
  ctx.log(`[browser] Running Playwright against ${paths.length} path(s)...`);
  const exitCode = await runPlaywrightDocker(
    runnerPath,
    inputPath,
    resultsPath,
    workDir,
    ctx.appUrl,
    TOTAL_TIMEOUT
  );
  if (exitCode !== 0 || !(0, import_fs6.existsSync)(resultsPath)) {
    return {
      gate: "browser",
      passed: false,
      detail: "Playwright execution failed",
      durationMs: Date.now() - start,
      results: []
    };
  }
  const rawResults = JSON.parse((0, import_fs6.readFileSync)(resultsPath, "utf-8"));
  const results = [];
  for (const r of rawResults.results ?? []) {
    const pred = browserPredicates.find(
      (p) => p.selector === r.selector && (p.property ?? "") === (r.property ?? "")
    );
    const expected = pred?.expected;
    const actual = r.actual;
    let passed;
    if (r.error) {
      passed = false;
    } else if (r.passed !== void 0 && r.passed !== null) {
      passed = r.passed;
    } else {
      passed = actual !== void 0 && actual !== null && actual !== "(not found)" && (expected === "exists" || !expected || normalizeColor(actual) === normalizeColor(expected));
    }
    const path = pred?.path ?? "/";
    results.push({
      predicate: pred ?? {},
      path,
      passed,
      expected,
      actual,
      detail: passed ? `${r.selector} ${r.property ?? "exists"}: OK (actual: ${actual})` : `${r.selector} ${r.property ?? "exists"}: expected "${expected}", got "${actual}"`
    });
  }
  const allPassed = results.length > 0 && results.every((r) => r.passed);
  const screenshots = {};
  for (const path of paths) {
    const safePath = path.replace(/\//g, "_") || "_root";
    const screenshotFile = (0, import_path6.join)(workDir, `screenshot-${safePath}.png`);
    if ((0, import_fs6.existsSync)(screenshotFile)) {
      try {
        screenshots[path] = (0, import_fs6.readFileSync)(screenshotFile);
        ctx.log(`[browser] Captured screenshot for ${path} (${screenshots[path].length} bytes)`);
      } catch {
      }
    }
  }
  try {
    const { rmSync: rmSync2 } = require("fs");
    rmSync2(workDir, { recursive: true, force: true });
  } catch {
  }
  return {
    gate: "browser",
    passed: allPassed,
    detail: allPassed ? `${results.length} browser predicate(s) passed` : formatBrowserFailures(results),
    durationMs: Date.now() - start,
    results,
    screenshots: Object.keys(screenshots).length > 0 ? screenshots : void 0
  };
}
function formatBrowserFailures(results) {
  const failures = results.filter((r) => !r.passed);
  const lines = ["BROWSER GATE FAILED:"];
  lines.push("  Path       Selector     Property          Expected    Actual");
  for (const f of failures) {
    const path = (f.path ?? "/").padEnd(10);
    const selector = (f.predicate.selector ?? "?").padEnd(12);
    const prop = (f.predicate.property ?? "-").padEnd(17);
    const expected = (f.expected ?? "?").padEnd(11);
    const actual = f.actual ?? "?";
    lines.push(`  ${path} ${selector} ${prop} ${expected} ${actual}`);
  }
  return lines.join("\n");
}
function normalizeColor(val) {
  if (!val) return val;
  return val.trim().replace(/\s+/g, " ").toLowerCase();
}
async function checkPlaywrightImage() {
  return new Promise((resolve2) => {
    const child = (0, import_child_process.spawn)("docker", ["image", "inspect", PLAYWRIGHT_IMAGE], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32"
    });
    child.on("close", (code) => resolve2(code === 0));
    child.on("error", () => resolve2(false));
  });
}
function findBrowserGateRunner() {
  const candidates = [
    (0, import_path6.join)(__dirname, "../../fixtures/browser-gate-runner.mjs"),
    (0, import_path6.join)(__dirname, "../../../src/tools/browser-gate-runner.mjs"),
    (0, import_path6.join)(process.cwd(), "node_modules/@sovereign-labs/verify/fixtures/browser-gate-runner.mjs")
  ];
  for (const c of candidates) {
    if ((0, import_fs6.existsSync)(c)) return c;
  }
  return null;
}
function runPlaywrightDocker(runnerPath, inputPath, resultsPath, workDir, appUrl, timeoutMs) {
  return new Promise((resolve2) => {
    const child = (0, import_child_process.spawn)("docker", [
      "run",
      "--rm",
      "--network",
      "host",
      "-v",
      `${runnerPath}:/app/browser-gate-runner.mjs:ro`,
      "-v",
      `${workDir}:/data`,
      PLAYWRIGHT_IMAGE,
      "node",
      "/app/browser-gate-runner.mjs"
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32"
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5e3);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve2(code ?? 1);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve2(1);
    });
  });
}

// src/gates/http.ts
var REQUEST_TIMEOUT = 1e4;
var TOTAL_TIMEOUT2 = 3e4;
async function runHttpGate(ctx) {
  const start = Date.now();
  const appUrl = ctx.appUrl;
  if (!appUrl) {
    return {
      gate: "http",
      passed: false,
      detail: "No app URL available \u2014 staging gate must run first",
      durationMs: Date.now() - start,
      results: []
    };
  }
  const httpPredicates = ctx.predicates.filter(
    (p) => p.type === "http" || p.type === "http_sequence"
  );
  if (httpPredicates.length === 0) {
    return {
      gate: "http",
      passed: true,
      detail: "No HTTP predicates to check",
      durationMs: Date.now() - start,
      results: []
    };
  }
  const results = [];
  for (const pred of httpPredicates) {
    if (Date.now() - start > TOTAL_TIMEOUT2) {
      results.push({
        predicate: pred,
        passed: false,
        detail: "HTTP gate total timeout exceeded"
      });
      continue;
    }
    if (pred.type === "http") {
      const result = await validateHttp(appUrl, pred);
      results.push(result);
    } else if (pred.type === "http_sequence") {
      const result = await validateHttpSequence(appUrl, pred);
      results.push(result);
    }
  }
  const allPassed = results.every((r) => r.passed);
  return {
    gate: "http",
    passed: allPassed,
    detail: allPassed ? `${results.length} HTTP predicate(s) passed` : `${results.filter((r) => !r.passed).length}/${results.length} HTTP predicate(s) failed`,
    durationMs: Date.now() - start,
    results
  };
}
async function validateHttp(baseUrl, pred) {
  const method = pred.method ?? "GET";
  const url = `${baseUrl}${pred.path ?? "/"}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    const fetchOpts = {
      method,
      signal: controller.signal,
      headers: { "Content-Type": "application/json" }
    };
    if (pred.body && (method === "POST" || method === "PUT" || method === "PATCH")) {
      fetchOpts.body = JSON.stringify(pred.body);
    }
    const resp = await fetch(url, fetchOpts);
    clearTimeout(timeout);
    const body = await resp.text();
    if (pred.expect?.status && resp.status !== pred.expect.status) {
      return {
        predicate: pred,
        passed: false,
        expected: `status ${pred.expect.status}`,
        actual: `status ${resp.status}`,
        detail: `${method} ${pred.path}: expected status ${pred.expect.status}, got ${resp.status}`
      };
    }
    if (pred.expect?.bodyContains) {
      const terms = Array.isArray(pred.expect.bodyContains) ? pred.expect.bodyContains : [pred.expect.bodyContains];
      for (const term of terms) {
        if (!body.includes(term)) {
          return {
            predicate: pred,
            passed: false,
            expected: `body contains "${term}"`,
            actual: body.substring(0, 200),
            detail: `${method} ${pred.path}: body missing "${term}"`
          };
        }
      }
    }
    if (pred.expect?.bodyRegex) {
      const regex = new RegExp(pred.expect.bodyRegex);
      if (!regex.test(body)) {
        return {
          predicate: pred,
          passed: false,
          expected: `body matches /${pred.expect.bodyRegex}/`,
          actual: body.substring(0, 200),
          detail: `${method} ${pred.path}: body doesn't match regex`
        };
      }
    }
    return {
      predicate: pred,
      passed: true,
      detail: `${method} ${pred.path}: status ${resp.status} OK`
    };
  } catch (err) {
    return {
      predicate: pred,
      passed: false,
      detail: `${method} ${pred.path}: ${err.message}`
    };
  }
}
async function validateHttpSequence(baseUrl, pred) {
  if (!pred.steps || pred.steps.length === 0) {
    return { predicate: pred, passed: true, detail: "No steps in sequence" };
  }
  for (let i = 0; i < pred.steps.length; i++) {
    const step = pred.steps[i];
    const url = `${baseUrl}${step.path}`;
    if (step.delayBeforeMs && step.delayBeforeMs > 0) {
      await new Promise((r) => setTimeout(r, step.delayBeforeMs));
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      const fetchOpts = {
        method: step.method,
        signal: controller.signal,
        headers: { "Content-Type": "application/json" }
      };
      if (step.body && (step.method === "POST" || step.method === "PUT")) {
        fetchOpts.body = JSON.stringify(step.body);
      }
      const resp = await fetch(url, fetchOpts);
      clearTimeout(timeout);
      const body = await resp.text();
      if (step.expect?.status && resp.status !== step.expect.status) {
        return {
          predicate: pred,
          passed: false,
          expected: `step ${i + 1}: status ${step.expect.status}`,
          actual: `status ${resp.status}`,
          detail: `Step ${i + 1} (${step.method} ${step.path}): expected ${step.expect.status}, got ${resp.status}`
        };
      }
      if (step.expect?.bodyContains) {
        const terms = Array.isArray(step.expect.bodyContains) ? step.expect.bodyContains : [step.expect.bodyContains];
        for (const term of terms) {
          if (!body.includes(term)) {
            return {
              predicate: pred,
              passed: false,
              expected: `step ${i + 1}: body contains "${term}"`,
              actual: body.substring(0, 200),
              detail: `Step ${i + 1} (${step.method} ${step.path}): body missing "${term}"`
            };
          }
        }
      }
    } catch (err) {
      return {
        predicate: pred,
        passed: false,
        detail: `Step ${i + 1} (${step.method} ${step.path}): ${err.message}`
      };
    }
  }
  return {
    predicate: pred,
    passed: true,
    detail: `All ${pred.steps.length} step(s) passed`
  };
}

// src/gates/vision.ts
var import_fs7 = require("fs");
var import_path7 = require("path");
var import_child_process2 = require("child_process");
var SCREENSHOT_TIMEOUT = 1e4;
async function runVisionGate(ctx) {
  const start = Date.now();
  const visualPredicates = ctx.predicates.filter(
    (p) => p.type === "css" || p.type === "html"
  );
  if (visualPredicates.length === 0) {
    return {
      gate: "vision",
      passed: true,
      detail: "No visual predicates \u2014 vision gate skipped",
      durationMs: Date.now() - start,
      claims: []
    };
  }
  const visionConfig = ctx.config.vision;
  if (!visionConfig?.call) {
    return {
      gate: "vision",
      passed: true,
      detail: "No vision callback configured \u2014 gate skipped",
      durationMs: Date.now() - start,
      claims: []
    };
  }
  const paths = [...new Set(visualPredicates.map((p) => p.path ?? "/"))].slice(0, 3);
  const providedScreenshots = visionConfig.screenshots;
  const screenshots = [];
  if (providedScreenshots && Object.keys(providedScreenshots).length > 0) {
    for (const path of paths) {
      const buf = providedScreenshots[path];
      if (buf) {
        ctx.log(`[vision] Using provided screenshot for ${path}`);
        screenshots.push({ path, buffer: buf });
      }
    }
  } else if (ctx.appUrl) {
    const workDir = (0, import_path7.join)(ctx.config.appDir, ".verify-tmp");
    (0, import_fs7.mkdirSync)(workDir, { recursive: true });
    for (const path of paths) {
      const screenshotPath = (0, import_path7.join)(workDir, `vision-${path.replace(/\//g, "_") || "root"}.png`);
      const took = await takeScreenshot(ctx.appUrl, path, screenshotPath, ctx.log);
      if (took && (0, import_fs7.existsSync)(screenshotPath)) {
        screenshots.push({ path, buffer: (0, import_fs7.readFileSync)(screenshotPath) });
      }
    }
  }
  if (screenshots.length === 0) {
    ctx.log("[vision] No screenshots captured \u2014 skipping vision gate");
    return {
      gate: "vision",
      passed: true,
      detail: "Screenshot capture failed \u2014 gate skipped",
      durationMs: Date.now() - start,
      claims: []
    };
  }
  const claimTexts = [];
  for (const p of visualPredicates) {
    const desc = describeVisualPredicate(p);
    claimTexts.push(desc);
  }
  ctx.log(`[vision] Sending screenshot to vision model with ${claimTexts.length} claim(s)...`);
  const prompt = buildVisionPrompt(claimTexts);
  let response;
  try {
    response = await visionConfig.call(screenshots[0].buffer, prompt);
  } catch (err) {
    ctx.log(`[vision] Vision callback failed: ${err.message}`);
    return {
      gate: "vision",
      passed: true,
      // Don't block on vision failure
      detail: `Vision callback failed: ${err.message} \u2014 gate skipped`,
      durationMs: Date.now() - start,
      claims: []
    };
  }
  const claims = parseVisionResponse(response, visualPredicates, claimTexts);
  const allVerified = claims.every((c) => c.verified);
  const failedCount = claims.filter((c) => !c.verified).length;
  const detail = allVerified ? `All ${claims.length} visual claim(s) verified` : `${failedCount}/${claims.length} claim(s) NOT VERIFIED`;
  return {
    gate: "vision",
    passed: allVerified,
    detail,
    durationMs: Date.now() - start,
    claims,
    screenshotPath: providedScreenshots ? void 0 : (0, import_path7.join)(ctx.config.appDir, ".verify-tmp", "vision-_root.png")
  };
}
async function takeScreenshot(baseUrl, path, outputPath, log) {
  const url = `${baseUrl}${path}`;
  log(`[vision] Taking screenshot of ${url}...`);
  const script = `
    const { chromium } = require('playwright');
    (async () => {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      await page.goto('${url}', { waitUntil: 'networkidle', timeout: 8000 });
      await page.screenshot({ fullPage: true, path: '/work/screenshot.png' });
      await browser.close();
    })();
  `;
  const workDir = (0, import_path7.join)(outputPath, "..");
  (0, import_fs7.writeFileSync)((0, import_path7.join)(workDir, "vision-screenshot.js"), script);
  return new Promise((resolve2) => {
    const proc = (0, import_child_process2.spawn)("docker", [
      "run",
      "--rm",
      "--network=host",
      "-e",
      "NODE_PATH=/app/node_modules",
      "-v",
      `${workDir}:/work`,
      "verify-playwright:latest",
      "node",
      "/work/vision-screenshot.js"
    ], { timeout: SCREENSHOT_TIMEOUT });
    let killed = false;
    let stderr = "";
    const timer = setTimeout(() => {
      killed = true;
      proc.kill();
    }, SCREENSHOT_TIMEOUT);
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed || code !== 0) {
        log(`[vision] Screenshot failed (code=${code}, killed=${killed}${stderr ? `, stderr=${stderr.slice(0, 200)}` : ""})`);
        resolve2(false);
      } else {
        const dockerOutput = (0, import_path7.join)(workDir, "screenshot.png");
        if ((0, import_fs7.existsSync)(dockerOutput)) {
          const { cpSync: cpSync2 } = require("fs");
          cpSync2(dockerOutput, outputPath);
          resolve2(true);
        } else {
          resolve2(false);
        }
      }
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve2(false);
    });
  });
}
function buildVisionPrompt(claims) {
  const numbered = claims.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return `You are verifying a web application screenshot against specific claims.

For each claim below, respond with EXACTLY one line:
  CLAIM N: VERIFIED
  or
  CLAIM N: NOT VERIFIED \u2014 <brief actual observation>

Be precise about colors (use hex when possible), element presence, and text content.
Do NOT add explanations beyond the one-line verdict per claim.

CLAIMS:
${numbered}`;
}
function parseVisionResponse(response, predicates, claimTexts) {
  const lines = response.split("\n").filter((l) => l.trim());
  const claims = [];
  for (let i = 0; i < claimTexts.length; i++) {
    const p = predicates[i];
    const desc = claimTexts[i];
    const claimLine = lines.find(
      (l) => l.toUpperCase().includes(`CLAIM ${i + 1}`)
    );
    if (claimLine) {
      const isVerified = claimLine.toUpperCase().includes("VERIFIED") && !claimLine.toUpperCase().includes("NOT VERIFIED");
      const dashIdx = claimLine.indexOf("\u2014");
      const detail = dashIdx >= 0 ? claimLine.substring(dashIdx + 1).trim() : isVerified ? "Verified" : "Not verified";
      claims.push({
        predicate: { type: p.type, selector: p.selector, property: p.property },
        description: desc,
        verified: isVerified,
        detail
      });
    } else {
      claims.push({
        predicate: { type: p.type, selector: p.selector, property: p.property },
        description: desc,
        verified: false,
        detail: "Vision model response did not address this claim"
      });
    }
  }
  return claims;
}
function describeVisualPredicate(p) {
  if (p.type === "css") {
    if (p.expected && p.expected !== "exists") {
      return `The CSS property "${p.property}" on elements matching "${p.selector}" should have value "${p.expected}"`;
    }
    return `Elements matching "${p.selector}" should exist and be visible`;
  }
  if (p.type === "html") {
    if (p.expected && p.expected !== "exists") {
      return `An HTML element matching "${p.selector}" should contain the text "${p.expected}"`;
    }
    return `An HTML element matching "${p.selector}" should exist and be visible`;
  }
  return `Predicate type=${p.type} selector=${p.selector}`;
}

// src/gates/triangulation.ts
function triangulate(deterministic, browser, vision) {
  const d = deterministic === null ? "absent" : deterministic ? "pass" : "fail";
  const b = browser === null ? "absent" : browser ? "pass" : "fail";
  const v = vision === null ? "absent" : vision ? "pass" : "fail";
  const authorities = { deterministic: d, browser: b, vision: v };
  const present = [d, b, v].filter((x) => x !== "absent");
  const authorityCount = present.length;
  if (authorityCount <= 1) {
    const single = present[0];
    if (!single || single === "pass") {
      return {
        authorities,
        authorityCount,
        confidence: "insufficient",
        outlier: "none",
        action: "proceed",
        reasoning: authorityCount === 0 ? "No verification authorities ran" : `Only ${namePresent(authorities)} ran (PASS) \u2014 insufficient for triangulation`
      };
    }
    return {
      authorities,
      authorityCount,
      confidence: "insufficient",
      outlier: "none",
      action: "rollback",
      reasoning: `Only ${namePresent(authorities)} ran and it FAILED`
    };
  }
  const passes = present.filter((x) => x === "pass").length;
  const fails = present.filter((x) => x === "fail").length;
  if (passes === authorityCount) {
    return {
      authorities,
      authorityCount,
      confidence: authorityCount === 3 ? "unanimous" : "majority",
      outlier: "none",
      action: "accept",
      reasoning: authorityCount === 3 ? "All three authorities agree: PASS" : `${authorityCount} authorities agree: PASS (${nameAbsent(authorities)} absent)`
    };
  }
  if (fails === authorityCount) {
    return {
      authorities,
      authorityCount,
      confidence: authorityCount === 3 ? "unanimous" : "majority",
      outlier: "none",
      action: "rollback",
      reasoning: authorityCount === 3 ? "All three authorities agree: FAIL" : `${authorityCount} authorities agree: FAIL (${nameAbsent(authorities)} absent)`
    };
  }
  if (authorityCount === 2) {
    return {
      authorities,
      authorityCount,
      confidence: "split",
      outlier: "none",
      action: "escalate",
      reasoning: `${nameByVerdict(authorities, "pass")} says PASS but ${nameByVerdict(authorities, "fail")} says FAIL \u2014 escalating`
    };
  }
  const outlier = findOutlier(d, b, v);
  const majorityVerdict = passes > fails ? "pass" : "fail";
  if (majorityVerdict === "pass") {
    return {
      authorities,
      authorityCount,
      confidence: "majority",
      outlier,
      action: "escalate",
      reasoning: `${outlier} disagrees (FAIL) while others say PASS \u2014 escalating`
    };
  }
  if (outlier === "vision") {
    return {
      authorities,
      authorityCount,
      confidence: "majority",
      outlier,
      action: "escalate",
      reasoning: `Vision says PASS but deterministic + browser say FAIL \u2014 vision may be optimistic`
    };
  }
  return {
    authorities,
    authorityCount,
    confidence: "majority",
    outlier,
    action: "rollback",
    reasoning: `${outlier} says PASS but the other two say FAIL \u2014 rolling back`
  };
}
function runTriangulationGate(gates, log) {
  const start = Date.now();
  const deterministicGates = gates.filter(
    (g) => g.gate === "grounding" || g.gate === "F9" || g.gate === "filesystem" || g.gate === "http" || g.gate === "invariants"
  );
  const deterministicPassed = deriveDeterministicVerdict(deterministicGates);
  const browserGate = gates.find((g) => g.gate === "browser");
  const browserPassed = browserGate ? browserGate.passed : null;
  const visionGate = gates.find((g) => g.gate === "vision");
  const visionPassed = deriveVisionVerdict(visionGate);
  const result = triangulate(deterministicPassed, browserPassed, visionPassed);
  log(`[triangulation] ${result.confidence} (${result.authorityCount}/3 authorities) \u2192 ${result.action}`);
  log(`[triangulation]   deterministic=${result.authorities.deterministic}, browser=${result.authorities.browser}, vision=${result.authorities.vision}`);
  if (result.outlier !== "none") {
    log(`[triangulation]   outlier: ${result.outlier}`);
  }
  log(`[triangulation]   ${result.reasoning}`);
  return {
    gate: "triangulation",
    passed: result.action === "accept" || result.action === "proceed",
    detail: `${result.confidence}: ${result.reasoning}`,
    durationMs: Date.now() - start,
    triangulation: result
  };
}
function deriveDeterministicVerdict(deterministicGates) {
  if (deterministicGates.length === 0) return null;
  if (deterministicGates.some((g) => !g.passed)) return false;
  return true;
}
function deriveVisionVerdict(visionGate) {
  if (!visionGate) return null;
  if (visionGate.detail.includes("skipped")) return null;
  return visionGate.passed;
}
function findOutlier(d, b, v) {
  if (d !== b && d !== v) return "deterministic";
  if (b !== d && b !== v) return "browser";
  if (v !== d && v !== b) return "vision";
  return "none";
}
function namePresent(a) {
  const names = [];
  if (a.deterministic !== "absent") names.push("deterministic");
  if (a.browser !== "absent") names.push("browser");
  if (a.vision !== "absent") names.push("vision");
  return names.join(" + ") || "none";
}
function nameAbsent(a) {
  const names = [];
  if (a.deterministic === "absent") names.push("deterministic");
  if (a.browser === "absent") names.push("browser");
  if (a.vision === "absent") names.push("vision");
  return names.join(" + ") || "none";
}
function nameByVerdict(a, verdict) {
  const names = [];
  if (a.deterministic === verdict) names.push("deterministic");
  if (a.browser === verdict) names.push("browser");
  if (a.vision === verdict) names.push("vision");
  return names.join(" + ") || "none";
}

// src/gates/invariants.ts
var PER_CHECK_TIMEOUT = 1e4;
var TOTAL_TIMEOUT3 = 3e4;
async function runInvariantsGate(ctx, invariants, runner) {
  const start = Date.now();
  if (invariants.length === 0) {
    return {
      gate: "invariants",
      passed: true,
      detail: "No invariants configured",
      durationMs: 0,
      results: []
    };
  }
  const results = [];
  for (const inv of invariants) {
    if (Date.now() - start > TOTAL_TIMEOUT3) {
      results.push({
        name: inv.name,
        passed: false,
        durationMs: 0,
        detail: "Budget exceeded \u2014 skipped"
      });
      continue;
    }
    const checkStart = Date.now();
    if (inv.type === "http") {
      const result = await checkHttpInvariant(inv, ctx.appUrl);
      results.push({ ...result, durationMs: Date.now() - checkStart });
    } else if (inv.type === "command" && runner) {
      const result = await checkCommandInvariant(inv, runner);
      results.push({ ...result, durationMs: Date.now() - checkStart });
    } else {
      results.push({
        name: inv.name,
        passed: true,
        durationMs: 0,
        detail: `Skipped \u2014 ${inv.type === "command" ? "no container runner" : "unknown type"}`
      });
    }
  }
  const allPassed = results.every((r) => r.passed);
  return {
    gate: "invariants",
    passed: allPassed,
    detail: allPassed ? `${results.length} invariant(s) passed` : `${results.filter((r) => !r.passed).length}/${results.length} invariant(s) failed`,
    durationMs: Date.now() - start,
    results
  };
}
async function checkHttpInvariant(inv, appUrl) {
  const url = `${appUrl}${inv.path ?? "/"}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PER_CHECK_TIMEOUT);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const body = await resp.text();
    if (inv.expect?.status && resp.status !== inv.expect.status) {
      return {
        name: inv.name,
        passed: false,
        actual: `status ${resp.status}`,
        detail: `${inv.name}: expected status ${inv.expect.status}, got ${resp.status}`
      };
    }
    if (inv.expect?.contains && !body.includes(inv.expect.contains)) {
      return {
        name: inv.name,
        passed: false,
        actual: body.substring(0, 100),
        detail: `${inv.name}: body missing "${inv.expect.contains}"`
      };
    }
    return {
      name: inv.name,
      passed: true,
      detail: `${inv.name}: OK (status ${resp.status})`
    };
  } catch (err) {
    return {
      name: inv.name,
      passed: false,
      detail: `${inv.name}: ${err.message}`
    };
  }
}
async function checkCommandInvariant(inv, runner) {
  if (!inv.command) {
    return { name: inv.name, passed: true, detail: `${inv.name}: no command specified \u2014 skipped` };
  }
  try {
    const result = await runner.exec(inv.command, { timeoutMs: PER_CHECK_TIMEOUT });
    if (inv.expect?.contains) {
      if (!result.stdout.includes(inv.expect.contains)) {
        return {
          name: inv.name,
          passed: false,
          actual: result.stdout.substring(0, 100),
          detail: `${inv.name}: output missing "${inv.expect.contains}"`
        };
      }
    } else if (result.exitCode !== 0) {
      return {
        name: inv.name,
        passed: false,
        actual: `exit code ${result.exitCode}`,
        detail: `${inv.name}: command failed with exit code ${result.exitCode}`
      };
    }
    return {
      name: inv.name,
      passed: true,
      detail: `${inv.name}: OK`
    };
  } catch (err) {
    return {
      name: inv.name,
      passed: false,
      detail: `${inv.name}: ${err.message}`
    };
  }
}

// src/gates/filesystem.ts
var import_fs8 = require("fs");
var import_path8 = require("path");
var import_crypto = require("crypto");
var FILESYSTEM_TYPES = /* @__PURE__ */ new Set([
  "filesystem_exists",
  "filesystem_absent",
  "filesystem_unchanged",
  "filesystem_count"
]);
function runFilesystemGate(ctx) {
  const start = Date.now();
  const predicateResults = [];
  const baseDir = ctx.stageDir ?? ctx.config.appDir;
  const fsPreds = ctx.predicates.map((p, i) => ({ pred: p, index: i })).filter(({ pred }) => FILESYSTEM_TYPES.has(pred.type));
  if (fsPreds.length === 0) {
    return {
      gate: "filesystem",
      passed: true,
      detail: "No filesystem predicates to check",
      durationMs: Date.now() - start,
      predicateResults: []
    };
  }
  const failures = [];
  for (const { pred, index } of fsPreds) {
    const filePath = pred.file ?? pred.path;
    if (!filePath) {
      failures.push(`Predicate p${index}: missing file/path field`);
      predicateResults.push({
        predicateIndex: index,
        type: pred.type,
        path: "(missing)",
        passed: false,
        expected: "file/path field required",
        actual: "missing"
      });
      continue;
    }
    const fullPath = (0, import_path8.join)(baseDir, filePath);
    const result = validateFilesystemPredicate(pred, fullPath, filePath, index);
    predicateResults.push(result);
    if (!result.passed) {
      failures.push(`p${index} [${pred.type}] ${filePath}: expected ${result.expected}, got ${result.actual}`);
    }
  }
  const passed = failures.length === 0;
  const detail = passed ? `All ${fsPreds.length} filesystem predicate(s) passed` : `${failures.length}/${fsPreds.length} filesystem predicate(s) failed: ${failures.join("; ")}`;
  return {
    gate: "filesystem",
    passed,
    detail,
    durationMs: Date.now() - start,
    predicateResults
  };
}
function validateFilesystemPredicate(pred, fullPath, relativePath, index) {
  switch (pred.type) {
    case "filesystem_exists": {
      const exists = (0, import_fs8.existsSync)(fullPath);
      return {
        predicateIndex: index,
        type: pred.type,
        path: relativePath,
        passed: exists,
        expected: "exists",
        actual: exists ? "exists" : "not found"
      };
    }
    case "filesystem_absent": {
      const exists = (0, import_fs8.existsSync)(fullPath);
      return {
        predicateIndex: index,
        type: pred.type,
        path: relativePath,
        passed: !exists,
        expected: "absent",
        actual: exists ? "exists (should be absent)" : "absent"
      };
    }
    case "filesystem_unchanged": {
      if (!pred.hash) {
        return {
          predicateIndex: index,
          type: pred.type,
          path: relativePath,
          passed: false,
          expected: "hash comparison",
          actual: "no hash captured at grounding time"
        };
      }
      if (!(0, import_fs8.existsSync)(fullPath)) {
        return {
          predicateIndex: index,
          type: pred.type,
          path: relativePath,
          passed: false,
          expected: `unchanged (hash: ${pred.hash.slice(0, 12)}...)`,
          actual: "file not found"
        };
      }
      try {
        const currentHash = hashFile(fullPath);
        const matched = currentHash === pred.hash;
        return {
          predicateIndex: index,
          type: pred.type,
          path: relativePath,
          passed: matched,
          expected: `unchanged (hash: ${pred.hash.slice(0, 12)}...)`,
          actual: matched ? "unchanged" : `modified (hash: ${currentHash.slice(0, 12)}...)`
        };
      } catch {
        return {
          predicateIndex: index,
          type: pred.type,
          path: relativePath,
          passed: false,
          expected: `unchanged (hash: ${pred.hash.slice(0, 12)}...)`,
          actual: "not a regular file or read error"
        };
      }
    }
    case "filesystem_count": {
      if (pred.count == null) {
        return {
          predicateIndex: index,
          type: pred.type,
          path: relativePath,
          passed: false,
          expected: "count field required",
          actual: "missing"
        };
      }
      if (!(0, import_fs8.existsSync)(fullPath)) {
        return {
          predicateIndex: index,
          type: pred.type,
          path: relativePath,
          passed: false,
          expected: `${pred.count} entries`,
          actual: "directory not found"
        };
      }
      try {
        const entries = (0, import_fs8.readdirSync)(fullPath);
        const matched = entries.length === pred.count;
        return {
          predicateIndex: index,
          type: pred.type,
          path: relativePath,
          passed: matched,
          expected: `${pred.count} entries`,
          actual: `${entries.length} entries`
        };
      } catch {
        return {
          predicateIndex: index,
          type: pred.type,
          path: relativePath,
          passed: false,
          expected: `${pred.count} entries`,
          actual: "not a directory or read error"
        };
      }
    }
    default:
      return {
        predicateIndex: index,
        type: pred.type,
        path: relativePath,
        passed: false,
        expected: "valid filesystem predicate type",
        actual: `unknown type: ${pred.type}`
      };
  }
}
function hashFile(filePath) {
  const content = (0, import_fs8.readFileSync)(filePath);
  return (0, import_crypto.createHash)("sha256").update(content).digest("hex");
}

// src/verify.ts
init_infrastructure();

// src/gates/serialization.ts
var import_fs9 = require("fs");
var import_path9 = require("path");
function compareValues(actual, expected, mode) {
  if (mode === "strict") {
    const match = JSON.stringify(actual) === JSON.stringify(expected);
    return {
      passed: match,
      detail: match ? "exact match" : `value mismatch`
    };
  }
  if (mode === "structural") {
    return compareStructure(actual, expected);
  }
  if (mode === "subset") {
    return checkSubset(actual, expected);
  }
  return { passed: false, detail: `Unknown comparison mode "${mode}". Use: exact, structural, or subset.` };
}
function compareStructure(actual, expected) {
  const actualType = typeof actual;
  const expectedType = typeof expected;
  if (actualType !== expectedType) {
    return { passed: false, detail: `type mismatch: expected ${expectedType}, got ${actualType}` };
  }
  if (actual === null && expected === null) return { passed: true, detail: "both null" };
  if (actual === null || expected === null) {
    return { passed: false, detail: `null mismatch: ${actual === null ? "actual" : "expected"} is null` };
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return { passed: false, detail: "expected array, got non-array" };
    if (expected.length > 0 && actual.length === 0) {
      return { passed: false, detail: "expected non-empty array, got empty" };
    }
    if (expected.length > 0 && actual.length > 0) {
      return compareStructure(actual[0], expected[0]);
    }
    return { passed: true, detail: "array structure matches" };
  }
  if (actualType === "object") {
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    const missingKeys = expectedKeys.filter((k) => !actualKeys.includes(k));
    if (missingKeys.length > 0) {
      return { passed: false, detail: `missing keys: ${missingKeys.join(", ")}` };
    }
    return { passed: true, detail: "structure matches" };
  }
  return { passed: true, detail: "primitive type matches" };
}
function checkSubset(actual, expected) {
  if (typeof expected !== "object" || expected === null) {
    return compareValues(actual, expected, "strict");
  }
  if (typeof actual !== "object" || actual === null) {
    return { passed: false, detail: "expected object for subset check, got non-object" };
  }
  const expectedObj = expected;
  const actualObj = actual;
  for (const [key, value] of Object.entries(expectedObj)) {
    if (!(key in actualObj)) {
      return { passed: false, detail: `missing key: ${key}` };
    }
    if (typeof value === "object" && value !== null) {
      const sub = checkSubset(actualObj[key], value);
      if (!sub.passed) return { passed: false, detail: `${key}: ${sub.detail}` };
    } else {
      if (JSON.stringify(actualObj[key]) !== JSON.stringify(value)) {
        return { passed: false, detail: `${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actualObj[key])}` };
      }
    }
  }
  return { passed: true, detail: "subset match" };
}
function validateSchema(data, schema) {
  const rawType = schema.type;
  const schemaTypes = rawType ? Array.isArray(rawType) ? rawType : [rawType] : void 0;
  if (schemaTypes) {
    const actualType = Array.isArray(data) ? "array" : data === null ? "null" : typeof data;
    const matchesAny = schemaTypes.some((st) => {
      if (st === "integer") return typeof data === "number" && Number.isInteger(data);
      return actualType === st;
    });
    if (!matchesAny) {
      return { passed: false, detail: `schema type mismatch: expected ${schemaTypes.join("|")}, got ${actualType}` };
    }
  }
  if (schemaTypes?.includes("object") && typeof data === "object" && data !== null) {
    const obj = data;
    const required = schema.required ?? [];
    for (const key of required) {
      if (!(key in obj)) {
        return { passed: false, detail: `missing required field: ${key}` };
      }
    }
    const properties = schema.properties;
    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in obj) {
          const result = validateSchema(obj[key], propSchema);
          if (!result.passed) return { passed: false, detail: `${key}: ${result.detail}` };
        }
      }
    }
  }
  if (schemaTypes?.includes("array") && Array.isArray(data)) {
    const items = schema.items;
    if (items && data.length > 0) {
      const result = validateSchema(data[0], items);
      if (!result.passed) return { passed: false, detail: `items[0]: ${result.detail}` };
    }
  }
  return { passed: true, detail: "schema valid" };
}
function runSerializationGate(ctx) {
  const start = Date.now();
  const serPreds = ctx.predicates.filter((p) => p.type === "serialization");
  if (serPreds.length === 0) {
    return {
      gate: "serialization",
      passed: true,
      detail: "No serialization predicates to check",
      durationMs: Date.now() - start,
      predicateResults: []
    };
  }
  const results = [];
  let allPassed = true;
  const details = [];
  for (let i = 0; i < serPreds.length; i++) {
    const p = serPreds[i];
    const result = validateSerializationPredicate(p, ctx.stageDir ?? ctx.config.appDir);
    results.push({ ...result, predicateId: `ser_p${i}` });
    if (!result.passed) {
      allPassed = false;
      details.push(result.actual ?? "failed");
    }
  }
  const passCount = results.filter((r) => r.passed).length;
  const detail = allPassed ? `All ${serPreds.length} serialization predicates passed` : `${passCount}/${serPreds.length} passed: ${details.join("; ")}`;
  ctx.log(`[serialization] ${detail}`);
  return {
    gate: "serialization",
    passed: allPassed,
    detail,
    durationMs: Date.now() - start,
    predicateResults: results
  };
}
function validateSerializationPredicate(p, appDir) {
  const fingerprint = `type=serialization|file=${p.file}|comparison=${p.comparison ?? "strict"}`;
  if (!p.file) {
    return { type: "serialization", passed: false, expected: "file path", actual: "(no file specified)", fingerprint };
  }
  const filePath = (0, import_path9.join)(appDir, p.file);
  if (!(0, import_fs9.existsSync)(filePath)) {
    return { type: "serialization", passed: false, expected: `file ${p.file} exists`, actual: "file not found", fingerprint };
  }
  let data;
  try {
    data = JSON.parse((0, import_fs9.readFileSync)(filePath, "utf-8"));
  } catch (e) {
    return { type: "serialization", passed: false, expected: "valid JSON", actual: `parse error: ${e.message}`, fingerprint };
  }
  if (p.schema) {
    const result = validateSchema(data, p.schema);
    return {
      type: "serialization",
      passed: result.passed,
      expected: "matches schema",
      actual: result.detail,
      fingerprint
    };
  }
  if (p.expected) {
    let expectedData;
    try {
      expectedData = JSON.parse(p.expected);
    } catch {
      return { type: "serialization", passed: false, expected: p.expected, actual: "invalid expected JSON", fingerprint };
    }
    const mode = p.comparison ?? "strict";
    const result = compareValues(data, expectedData, mode);
    return {
      type: "serialization",
      passed: result.passed,
      expected: `${mode}: ${p.expected.substring(0, 50)}`,
      actual: result.detail,
      fingerprint
    };
  }
  return { type: "serialization", passed: true, expected: "valid JSON", actual: "valid JSON", fingerprint };
}

// src/gates/config.ts
var import_fs10 = require("fs");
var import_path10 = require("path");
function parseDotenv(content) {
  const result = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
function parseSimpleYaml(content) {
  const result = {};
  const lines = content.split("\n");
  const stack = [{ indent: -1, obj: result }];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const content_line = trimmed.trim();
    const colonIdx = content_line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = content_line.slice(0, colonIdx).trim();
    let value = content_line.slice(colonIdx + 1).trim();
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;
    if (value === "" || value === "|" || value === ">") {
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else {
      if (value.includes(" #")) {
        value = value.slice(0, value.indexOf(" #")).trim();
      }
      if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }
      if (value === "true") parent[key] = true;
      else if (value === "false") parent[key] = false;
      else if (value === "null") parent[key] = null;
      else if (/^-?\d+(\.\d+)?$/.test(value)) parent[key] = Number(value);
      else parent[key] = value;
    }
  }
  return result;
}
function flattenObject(obj, prefix = "") {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value, fullKey));
    } else {
      result[fullKey] = String(value);
    }
  }
  return result;
}
function loadConfigValues(appDir, source) {
  const values = {};
  const sources = {};
  const candidates = [
    { file: ".env", type: "dotenv" },
    { file: ".env.local", type: "dotenv" },
    { file: ".env.production", type: "dotenv" },
    { file: "config.json", type: "json" },
    { file: "config.yaml", type: "yaml" },
    { file: "config.yml", type: "yaml" },
    { file: "package.json", type: "json" }
  ];
  for (const { file, type } of candidates) {
    if (source && type !== source) continue;
    const filePath = (0, import_path10.join)(appDir, file);
    if (!(0, import_fs10.existsSync)(filePath)) continue;
    try {
      const content = (0, import_fs10.readFileSync)(filePath, "utf-8");
      let parsed;
      if (type === "dotenv") {
        parsed = parseDotenv(content);
      } else if (type === "json") {
        const json = JSON.parse(content);
        parsed = flattenObject(json);
      } else if (type === "yaml") {
        const yaml = parseSimpleYaml(content);
        parsed = flattenObject(yaml);
      } else {
        continue;
      }
      for (const [key, value] of Object.entries(parsed)) {
        if (!(key in values)) {
          values[key] = value;
          sources[key] = file;
        }
      }
    } catch {
    }
  }
  return { values, sources };
}
function runConfigGate(ctx) {
  const start = Date.now();
  const configPreds = ctx.predicates.filter((p) => p.type === "config");
  if (configPreds.length === 0) {
    return {
      gate: "config",
      passed: true,
      detail: "No config predicates to check",
      durationMs: Date.now() - start,
      predicateResults: []
    };
  }
  const results = [];
  let allPassed = true;
  const details = [];
  for (let i = 0; i < configPreds.length; i++) {
    const p = configPreds[i];
    const result = validateConfigPredicate(p, ctx.stageDir ?? ctx.config.appDir);
    results.push({ ...result, predicateId: `cfg_p${i}` });
    if (!result.passed) {
      allPassed = false;
      details.push(result.actual ?? "failed");
    }
  }
  const passCount = results.filter((r) => r.passed).length;
  const detail = allPassed ? `All ${configPreds.length} config predicates passed` : `${passCount}/${configPreds.length} passed: ${details.join("; ")}`;
  ctx.log(`[config] ${detail}`);
  return {
    gate: "config",
    passed: allPassed,
    detail,
    durationMs: Date.now() - start,
    predicateResults: results
  };
}
function validateConfigPredicate(p, appDir) {
  const fingerprint = `type=config|key=${p.key}|source=${p.source ?? "any"}`;
  if (!p.key) {
    return { type: "config", passed: false, expected: "config key", actual: "(no key specified)", fingerprint };
  }
  const { values, sources } = loadConfigValues(appDir, p.source);
  if (!(p.key in values)) {
    return {
      type: "config",
      passed: false,
      expected: p.expected ?? `${p.key} exists`,
      actual: `key "${p.key}" not found in ${p.source ?? "any config file"}`,
      fingerprint
    };
  }
  const actualValue = values[p.key];
  const sourceFile = sources[p.key];
  if (!p.expected || p.expected === "exists") {
    return {
      type: "config",
      passed: true,
      expected: `${p.key} exists`,
      actual: `${p.key} = "${actualValue}" (from ${sourceFile})`,
      fingerprint
    };
  }
  const passed = actualValue === p.expected;
  return {
    type: "config",
    passed,
    expected: `${p.key} == "${p.expected}"`,
    actual: `${p.key} = "${actualValue}" (from ${sourceFile})`,
    fingerprint
  };
}

// src/gates/security.ts
var import_fs11 = require("fs");
var import_path11 = require("path");
function readSourceFiles(appDir) {
  const files = [];
  const CODE_EXTS4 = /* @__PURE__ */ new Set([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".html", ".htm", ".ejs", ".hbs"]);
  const SKIP = /* @__PURE__ */ new Set(["node_modules", ".git", ".next", "dist", ".sovereign", ".verify"]);
  function scan(dir, rel) {
    try {
      const entries = (0, import_fs11.readdirSync)(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const fullPath = (0, import_path11.join)(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, rel ? `${rel}/${entry.name}` : entry.name);
        } else if (CODE_EXTS4.has((0, import_path11.extname)(entry.name).toLowerCase())) {
          try {
            const content = (0, import_fs11.readFileSync)(fullPath, "utf-8");
            files.push({ path: fullPath, content, relativePath: rel ? `${rel}/${entry.name}` : entry.name });
          } catch {
          }
        }
      }
    } catch {
    }
  }
  scan(appDir, "");
  return files;
}
function scanXSS(files) {
  const findings = [];
  const patterns = [
    { regex: /innerHTML\s*=(?!=)/g, detail: "Direct innerHTML assignment (potential XSS)" },
    { regex: /document\.write\s*\(/g, detail: "document.write usage (potential XSS)" },
    { regex: /eval\s*\(/g, detail: "eval() usage (potential code injection)" },
    { regex: /\$\{.*\}\s*(?:innerHTML|dangerouslySetInnerHTML)/g, detail: "Template literal in HTML injection context" },
    { regex: /dangerouslySetInnerHTML/g, detail: "React dangerouslySetInnerHTML usage" }
  ];
  for (const file of files) {
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const { regex, detail } of patterns) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          findings.push({ check: "xss", file: file.relativePath, line: i + 1, detail, severity: "high" });
        }
      }
    }
  }
  return findings;
}
function scanSQLInjection(files) {
  const findings = [];
  const patterns = [
    { regex: /(?:query|execute|run|fetch|prepare|raw)\s*\(\s*[`'"].*\$\{/g, detail: "Template literal in SQL query (potential injection)" },
    { regex: /(?:query|execute|run|fetch|prepare|raw)\s*\(\s*['"].*\+/g, detail: "String concatenation in SQL query (potential injection)" },
    { regex: /(?:SELECT|INSERT|UPDATE|DELETE|DROP)\s.*\+\s*(?:req\.|params\.|body\.|query\.|headers\[)/gi, detail: "User input concatenated into SQL" },
    { regex: /(?:SELECT|INSERT|UPDATE|DELETE|DROP)\s.*\.join\s*\(/gi, detail: "Array join in SQL construction (potential injection)" }
  ];
  const multiLinePatterns = [
    { regex: /(?:query|execute|run|fetch|prepare|raw)\s*\(\s*\n\s*`[^`]*\$\{/g, detail: "Template literal in SQL query (potential injection)" },
    { regex: /(?:query|execute|run|fetch|prepare|raw)\s*\(\s*\n\s*['"][^'"]*\+/g, detail: "String concatenation in SQL query (potential injection)" }
  ];
  for (const file of files) {
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const { regex, detail } of patterns) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          findings.push({ check: "sql_injection", file: file.relativePath, line: i + 1, detail, severity: "high" });
        }
      }
    }
    for (const { regex, detail } of multiLinePatterns) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(file.content)) !== null) {
        const line = file.content.substring(0, match.index).split("\n").length;
        findings.push({ check: "sql_injection", file: file.relativePath, line, detail, severity: "high" });
      }
    }
  }
  return findings;
}
function scanSecrets(files) {
  const findings = [];
  const patterns = [
    // 649a: Variable name patterns (SCREAMING_SNAKE + camelCase)
    { regex: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/gi, detail: "Hardcoded password" },
    { regex: /(?:api_key|apikey|api_secret|API_KEY|API_SECRET)\s*[:=]\s*['"][^'"]{8,}['"]/gi, detail: "Hardcoded API key" },
    { regex: /(?:secret|token|SECRET|TOKEN)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{20,}['"]/gi, detail: "Hardcoded secret/token" },
    { regex: /(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)\s*=\s*['"]?[A-Z0-9]{16,}['"]?/g, detail: "Hardcoded AWS credential" },
    { regex: /(?:secretKey|apiKey|privateKey|accessToken|authToken|dbPassword|masterKey|signingKey)\s*[:=]\s*['"][^'"]{4,}['"]/g, detail: "Hardcoded secret (camelCase name)" },
    { regex: /(?:OPENAI_API_KEY|STRIPE_SECRET|STRIPE_KEY|GITHUB_TOKEN|SLACK_TOKEN|ANTHROPIC_API_KEY|GEMINI_API_KEY)\s*[:=]\s*['"][^'"]{4,}['"]/g, detail: "Hardcoded provider API key" },
    // 649b: Value prefix patterns (catches secrets regardless of variable name)
    { regex: /['"]sk-[A-Za-z0-9]{20,}['"]/g, detail: "OpenAI API key prefix (sk-)" },
    { regex: /['"]sk_(?:live|test)_[A-Za-z0-9]{20,}['"]/g, detail: "Stripe API key prefix (sk_live_/sk_test_)" },
    { regex: /['"]AIzaSy[A-Za-z0-9_-]{30,}['"]/g, detail: "Google API key prefix (AIzaSy)" },
    { regex: /['"]ghp_[A-Za-z0-9]{30,}['"]/g, detail: "GitHub personal access token (ghp_)" },
    { regex: /['"]gho_[A-Za-z0-9]{30,}['"]/g, detail: "GitHub OAuth token (gho_)" },
    { regex: /['"]github_pat_[A-Za-z0-9_]{30,}['"]/g, detail: "GitHub fine-grained token (github_pat_)" },
    { regex: /['"]AKIA[A-Z0-9]{12,}['"]/g, detail: "AWS access key ID prefix (AKIA)" },
    { regex: /['"]xoxb-[A-Za-z0-9-]{20,}['"]/g, detail: "Slack bot token (xoxb-)" },
    { regex: /['"]xoxp-[A-Za-z0-9-]{20,}['"]/g, detail: "Slack user token (xoxp-)" },
    { regex: /['"]sk-ant-[A-Za-z0-9-]{20,}['"]/g, detail: "Anthropic API key prefix (sk-ant-)" },
    // 649c: Structural value patterns
    { regex: /-----BEGIN\s+(?:RSA\s+)?(?:PRIVATE|EC)\s+KEY-----/g, detail: "Private key in source code" },
    { regex: /['"]eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}['"]/g, detail: "JWT token in source code (eyJ prefix)" },
    { regex: /process\.env\.(?:SECRET|KEY|TOKEN|PASSWORD|PRIVATE)/gi, detail: "Sensitive env var accessed in code (potential exposure)" }
  ];
  for (const file of files) {
    if (file.relativePath.startsWith(".env")) continue;
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;
      if (/\/\/\s*test|\/\*\s*test|test.?fixture/i.test(lines[i])) continue;
      if (/[:=]\s*['"]test[-_]/i.test(lines[i])) continue;
      for (const { regex, detail } of patterns) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          findings.push({ check: "secrets_in_code", file: file.relativePath, line: i + 1, detail, severity: "high" });
        }
      }
    }
  }
  return findings;
}
function scanCSP(files) {
  const hasCSP = files.some(
    (f) => f.content.includes("Content-Security-Policy") || f.content.includes("content-security-policy") || f.content.includes("helmet")
  );
  if (!hasCSP) {
    return [{ check: "csp", file: "(project)", line: 0, detail: "No Content-Security-Policy header found", severity: "medium" }];
  }
  return [];
}
function scanCORS(files) {
  const findings = [];
  for (const file of files) {
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (/Access-Control-Allow-Origin.*\*/i.test(lines[i]) || /cors\(\s*\)/.test(lines[i]) || /origin:\s*['"]?\*['"]?/.test(lines[i])) {
        findings.push({
          check: "cors",
          file: file.relativePath,
          line: i + 1,
          detail: "CORS wildcard (*) allows any origin",
          severity: "medium"
        });
      }
    }
  }
  return findings;
}
function scanEvalUsage(files) {
  const findings = [];
  const patterns = [
    { regex: /\beval\s*\(/g, detail: "eval() usage (code injection risk)" },
    { regex: /new\s+Function\s*\(/g, detail: "new Function() usage (code injection risk)" },
    { regex: /setTimeout\s*\(\s*['"`]/g, detail: "setTimeout with string argument (implicit eval)" },
    { regex: /setInterval\s*\(\s*['"`]/g, detail: "setInterval with string argument (implicit eval)" }
  ];
  for (const file of files) {
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      for (const { regex, detail } of patterns) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          findings.push({ check: "eval_usage", file: file.relativePath, line: i + 1, detail, severity: "high" });
        }
      }
    }
  }
  return findings;
}
function scanPrototypePollution(files) {
  const findings = [];
  const patterns = [
    { regex: /__proto__/g, detail: "__proto__ access (prototype pollution risk)" },
    { regex: /constructor\s*\[\s*['"]prototype['"]\s*\]/g, detail: "constructor.prototype access (prototype pollution risk)" },
    { regex: /Object\.assign\s*\(\s*(?:{}|Object\.prototype)/g, detail: "Object.assign to Object.prototype (prototype pollution)" }
  ];
  for (const file of files) {
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const { regex, detail } of patterns) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          findings.push({ check: "prototype_pollution", file: file.relativePath, line: i + 1, detail, severity: "high" });
        }
      }
    }
  }
  return findings;
}
function scanPathTraversal(files) {
  const findings = [];
  const patterns = [
    { regex: /(?:readFile|readFileSync|createReadStream|writeFile|writeFileSync)\s*\(\s*(?:req\.|params\.|body\.|query\.|args\.)/g, detail: "User input in file operation (path traversal risk)" },
    { regex: /(?:readFile|readFileSync|createReadStream)\s*\([^)]*\+[^)]*(?:req|params|body|query)/g, detail: "Concatenated user input in file path" }
  ];
  for (const file of files) {
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const { regex, detail } of patterns) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          findings.push({ check: "path_traversal", file: file.relativePath, line: i + 1, detail, severity: "high" });
        }
      }
    }
  }
  return findings;
}
function scanOpenRedirect(files) {
  const findings = [];
  const patterns = [
    { regex: /(?:redirect|location)\s*(?:=|\()\s*(?:req\.|params\.|body\.|query\.)/g, detail: "User input in redirect (open redirect risk)" },
    { regex: /res\.redirect\s*\(\s*(?:req\.|params\.|query\.)/g, detail: "Express redirect with user input" },
    { regex: /Location['"]\s*:\s*(?:req\.|params\.|query\.|body\.|\w+\s*\+)/g, detail: "User input in Location header (open redirect risk)" },
    { regex: /window\.location\s*=\s*[`'"].*\$\{/g, detail: "Template literal in window.location (client-side redirect)" },
    { regex: /window\.location\s*=\s*['"].*\+/g, detail: "String concat in window.location (client-side redirect)" },
    { regex: /['"]Location['"]\s*:\s*['"].*\+\s*\w+/g, detail: "Variable in Location header (open redirect risk)" }
  ];
  for (const file of files) {
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const { regex, detail } of patterns) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          findings.push({ check: "open_redirect", file: file.relativePath, line: i + 1, detail, severity: "medium" });
        }
      }
    }
  }
  return findings;
}
function scanRateLimiting(files) {
  const findings = [];
  const hasRateLimit = files.some(
    (f) => /rate.?limit/i.test(f.content) || /express-rate-limit/i.test(f.content) || /throttle/i.test(f.content)
  );
  if (!hasRateLimit) {
    for (const file of files) {
      const lines = file.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (/(?:post|app\.post)\s*\(\s*['"]\/(?:auth|login|signin|register|reset|password|verify|confirm)/i.test(lines[i])) {
          findings.push({ check: "rate_limiting", file: file.relativePath, line: i + 1, detail: "Auth/sensitive endpoint without rate limiting", severity: "medium" });
        }
      }
    }
  }
  return findings;
}
function scanInsecureDeserialization(files) {
  const findings = [];
  const patterns = [
    { regex: /JSON\.parse\s*\(\s*(?:req\.|params\.|body\.|query\.|headers\.)/g, detail: "JSON.parse on user input without validation" },
    { regex: /(?:unserialize|deserialize)\s*\(\s*(?:req\.|params\.|body\.|query\.)/g, detail: "Deserialization of user input" }
  ];
  for (const file of files) {
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const { regex, detail } of patterns) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          findings.push({ check: "insecure_deserialization", file: file.relativePath, line: i + 1, detail, severity: "medium" });
        }
      }
    }
  }
  return findings;
}
function runSecurityCheck(check, files) {
  switch (check) {
    case "xss":
      return scanXSS(files);
    case "sql_injection":
      return scanSQLInjection(files);
    case "secrets_in_code":
      return scanSecrets(files);
    case "csp":
      return scanCSP(files);
    case "cors":
      return scanCORS(files);
    case "csrf":
      return [];
    // CSRF is structural — hard to detect statically
    case "auth_header":
      return [];
    // Auth header is runtime — deferred to HTTP gate
    case "eval_usage":
      return scanEvalUsage(files);
    case "prototype_pollution":
      return scanPrototypePollution(files);
    case "path_traversal":
      return scanPathTraversal(files);
    case "open_redirect":
      return scanOpenRedirect(files);
    case "rate_limiting":
      return scanRateLimiting(files);
    case "insecure_deserialization":
      return scanInsecureDeserialization(files);
    default:
      return [];
  }
}
function runSecurityGate(ctx) {
  const start = Date.now();
  const secPreds = ctx.predicates.filter((p) => p.type === "security");
  if (secPreds.length === 0) {
    return {
      gate: "security",
      passed: true,
      detail: "No security predicates to check",
      durationMs: Date.now() - start,
      predicateResults: []
    };
  }
  let sourceFiles;
  if (ctx.edits.length > 0) {
    sourceFiles = ctx.edits.filter((e) => e.replace).map((e) => ({
      path: e.file,
      content: (e.search || "") + "\n" + e.replace,
      relativePath: e.file
    }));
  } else {
    const scanDir = ctx.stageDir ?? ctx.config.appDir;
    sourceFiles = readSourceFiles(scanDir);
  }
  const results = [];
  let allPassed = true;
  const details = [];
  for (let i = 0; i < secPreds.length; i++) {
    const p = secPreds[i];
    const result = validateSecurityPredicate(p, sourceFiles);
    results.push({ ...result, predicateId: `sec_p${i}` });
    if (!result.passed) {
      allPassed = false;
      details.push(result.actual ?? "failed");
    }
  }
  const passCount = results.filter((r) => r.passed).length;
  const detail = allPassed ? `All ${secPreds.length} security predicates passed` : `${passCount}/${secPreds.length} passed: ${details.join("; ")}`;
  ctx.log(`[security] ${detail}`);
  return {
    gate: "security",
    passed: allPassed,
    detail,
    durationMs: Date.now() - start,
    predicateResults: results
  };
}
function validateSecurityPredicate(p, files) {
  const check = p.securityCheck;
  const fingerprint = `type=security|check=${check}`;
  if (!check) {
    return { type: "security", passed: false, expected: "security check type", actual: "(no securityCheck specified)", fingerprint };
  }
  const expected = p.expected ?? "no_findings";
  const findings = runSecurityCheck(check, files);
  if (expected === "no_findings" || expected === "clean" || expected === "pass") {
    const passed = findings.length === 0;
    return {
      type: "security",
      passed,
      expected: `${check}: no findings`,
      actual: passed ? `${check}: clean` : `${findings.length} finding(s): ${findings.slice(0, 3).map((f) => `${f.file}:${f.line} ${f.detail}`).join("; ")}`,
      fingerprint
    };
  }
  if (expected === "has_findings" || expected === "fail") {
    const passed = findings.length > 0;
    return {
      type: "security",
      passed,
      expected: `${check}: has findings`,
      actual: passed ? `${findings.length} finding(s) detected` : `${check}: no findings (expected some)`,
      fingerprint
    };
  }
  return { type: "security", passed: false, expected, actual: `unknown expected value: ${expected}`, fingerprint };
}

// src/gates/a11y.ts
var import_fs12 = require("fs");
var import_path12 = require("path");
function readHTMLContent(appDir) {
  const files = [];
  const HTML_EXTS = /* @__PURE__ */ new Set([".html", ".htm", ".ejs", ".hbs", ".jsx", ".tsx", ".js", ".ts"]);
  const SKIP = /* @__PURE__ */ new Set(["node_modules", ".git", ".next", "dist", ".sovereign", ".verify"]);
  function scan(dir, rel) {
    try {
      const entries = (0, import_fs12.readdirSync)(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const fullPath = (0, import_path12.join)(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, rel ? `${rel}/${entry.name}` : entry.name);
        } else if (HTML_EXTS.has((0, import_path12.extname)(entry.name).toLowerCase())) {
          try {
            const content = (0, import_fs12.readFileSync)(fullPath, "utf-8");
            if (content.includes("<") && (content.includes("</") || content.includes("/>"))) {
              files.push({ relativePath: rel ? `${rel}/${entry.name}` : entry.name, content });
            }
          } catch {
          }
        }
      }
    } catch {
    }
  }
  scan(appDir, "");
  return files;
}
function checkAltText(files) {
  const findings = [];
  const imgRegex = /<img\b[^>]*>/gi;
  for (const file of files) {
    let match;
    imgRegex.lastIndex = 0;
    while ((match = imgRegex.exec(file.content)) !== null) {
      const tag = match[0];
      if (/role\s*=\s*["'](presentation|none)["']/i.test(tag)) continue;
      if (/aria-label\s*=/i.test(tag)) continue;
      if (!tag.includes("alt=") && !tag.includes("alt =")) {
        findings.push({
          check: "alt_text",
          file: file.relativePath,
          detail: "Image missing alt attribute",
          severity: "error"
        });
      } else {
        const altMatch = tag.match(/alt\s*=\s*["']([^"']*)["']/i);
        if (altMatch) {
          const altText = altMatch[1].trim().toLowerCase();
          if (altText === "") {
            findings.push({ check: "alt_text", file: file.relativePath, detail: "Image has empty alt attribute", severity: "warning" });
          } else if (["image", "picture", "photo", "logo"].includes(altText)) {
            findings.push({ check: "alt_text", file: file.relativePath, detail: `Image has generic alt text: "${altMatch[1]}"`, severity: "warning" });
          }
        }
      }
    }
  }
  return findings;
}
function checkHeadingHierarchy(files) {
  const findings = [];
  const headingRegex = /<h([1-6])\b/gi;
  const emptyHeadingRegex = /<h([1-6])\b[^>]*>(\s*(<[^>]*style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[^<]*<\/[^>]+>\s*)*)<\/h\1>/gi;
  for (const file of files) {
    let emptyMatch;
    emptyHeadingRegex.lastIndex = 0;
    while ((emptyMatch = emptyHeadingRegex.exec(file.content)) !== null) {
      const innerContent = emptyMatch[2];
      const textOnly = innerContent.replace(/<[^>]*>/g, "").trim();
      if (textOnly === "") {
        findings.push({
          check: "heading_hierarchy",
          file: file.relativePath,
          detail: `Empty heading: h${emptyMatch[1]}`,
          severity: "error"
        });
      }
    }
    const headingWithHiddenRegex = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
    let hiddenMatch;
    headingWithHiddenRegex.lastIndex = 0;
    while ((hiddenMatch = headingWithHiddenRegex.exec(file.content)) !== null) {
      const inner = hiddenMatch[2];
      if (inner.replace(/<[^>]*>/g, "").trim() === "" && !/<[^>]*style/i.test(inner)) continue;
      const withoutHidden = inner.replace(/<[^>]*style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi, "");
      const visibleText = withoutHidden.replace(/<[^>]*>/g, "").trim();
      if (visibleText === "" && /<[^>]*style\s*=\s*["'][^"']*display\s*:\s*none/i.test(inner)) {
        findings.push({
          check: "heading_hierarchy",
          file: file.relativePath,
          detail: `Empty heading: h${hiddenMatch[1]} (contains only hidden text)`,
          severity: "error"
        });
      }
    }
    const headings = [];
    let match;
    const contentWithoutComments = file.content.replace(/<!--[\s\S]*?-->/g, "");
    headingRegex.lastIndex = 0;
    while ((match = headingRegex.exec(contentWithoutComments)) !== null) {
      headings.push(parseInt(match[1], 10));
    }
    for (let i = 1; i < headings.length; i++) {
      if (headings[i] > headings[i - 1] + 1) {
        findings.push({
          check: "heading_hierarchy",
          file: file.relativePath,
          detail: `Heading level skipped: h${headings[i - 1]} \u2192 h${headings[i]}`,
          severity: "warning"
        });
      }
    }
  }
  return findings;
}
function checkLandmarks(files) {
  const allContent = files.map((f) => f.content).join("\n");
  const findings = [];
  const landmarks = [
    { tag: "main", role: 'role="main"', label: "<main>" },
    { tag: "nav", role: 'role="navigation"', label: "<nav>" }
  ];
  for (const { tag, role, label } of landmarks) {
    const hasTag = new RegExp(`<${tag}\\b`, "i").test(allContent);
    const hasRole = allContent.includes(role);
    if (!hasTag && !hasRole) {
      findings.push({
        check: "landmark",
        file: "(project)",
        detail: `Missing landmark: ${label} or ${role}`,
        severity: "warning"
      });
    }
  }
  return findings;
}
function checkAriaLabels(files) {
  const findings = [];
  const buttonRegex = /<button\b[^>]*>(\s*)<\/button>/gi;
  const iconButtonRegex = /<button\b[^>]*>\s*<(?:i|svg|span)\b[^>]*(?:\/>|>.*?<\/(?:i|svg|span)>)\s*<\/button>/gi;
  for (const file of files) {
    let match;
    buttonRegex.lastIndex = 0;
    while ((match = buttonRegex.exec(file.content)) !== null) {
      if (!match[0].includes("aria-label") && !match[0].includes("aria-labelledby")) {
        findings.push({
          check: "aria_label",
          file: file.relativePath,
          detail: "Empty button without aria-label",
          severity: "error"
        });
      }
    }
    iconButtonRegex.lastIndex = 0;
    while ((match = iconButtonRegex.exec(file.content)) !== null) {
      if (!match[0].includes("aria-label") && !match[0].includes("aria-labelledby") && !match[0].includes("title=")) {
        findings.push({
          check: "aria_label",
          file: file.relativePath,
          detail: "Icon-only button without aria-label",
          severity: "error"
        });
      }
    }
  }
  return findings;
}
function checkFocusManagement(files) {
  const findings = [];
  for (const file of files) {
    if (/tabindex\s*=\s*["']?[1-9]/i.test(file.content)) {
      findings.push({
        check: "focus_management",
        file: file.relativePath,
        detail: "tabindex > 0 disrupts natural tab order",
        severity: "warning"
      });
    }
    if (/outline\s*:\s*none/i.test(file.content) && !/:focus-visible/i.test(file.content)) {
      findings.push({
        check: "focus_management",
        file: file.relativePath,
        detail: "outline: none without :focus-visible alternative",
        severity: "warning"
      });
    }
  }
  return findings;
}
function checkFormLabels(files) {
  const findings = [];
  const inputRegex = /<input\b[^>]*>/gi;
  for (const file of files) {
    let match;
    inputRegex.lastIndex = 0;
    while ((match = inputRegex.exec(file.content)) !== null) {
      const tag = match[0];
      if (/type\s*=\s*["'](?:hidden|submit|button|reset|image)["']/i.test(tag)) continue;
      if (!tag.includes("aria-label") && !tag.includes("aria-labelledby") && !tag.includes("id=")) {
        findings.push({ check: "form_labels", file: file.relativePath, detail: "Input without associated label or aria-label", severity: "error" });
      } else if (tag.includes("id=")) {
        const idMatch = tag.match(/id\s*=\s*["']([^"']+)["']/);
        if (idMatch) {
          const hasLabel = files.some((f) => new RegExp(`for\\s*=\\s*["']${idMatch[1]}["']`).test(f.content));
          if (!hasLabel && !tag.includes("aria-label")) {
            findings.push({ check: "form_labels", file: file.relativePath, detail: `Input #${idMatch[1]} has no matching <label for="">`, severity: "warning" });
          }
        }
      }
    }
  }
  return findings;
}
function checkLinkText(files) {
  const findings = [];
  const BAD_TEXTS = ["click here", "here", "read more", "more", "link", "this"];
  const linkRegex = /<a\b([^>]*)>(.*?)<\/a>/gi;
  for (const file of files) {
    let match;
    linkRegex.lastIndex = 0;
    while ((match = linkRegex.exec(file.content)) !== null) {
      const attrs = match[1];
      const text = match[2].replace(/<[^>]*>/g, "").trim().toLowerCase();
      if (text === "") {
        const hasAriaLabel = /aria-label\s*=/i.test(attrs);
        if (!hasAriaLabel) {
          findings.push({ check: "link_text", file: file.relativePath, detail: `Empty link text`, severity: "error" });
        }
      } else if (BAD_TEXTS.includes(text)) {
        findings.push({ check: "link_text", file: file.relativePath, detail: `Non-descriptive link text: "${text}"`, severity: "warning" });
      }
    }
  }
  return findings;
}
function checkLangAttr(files) {
  const allContent = files.map((f) => f.content).join("\n");
  if (/<html\b/i.test(allContent) && !/<html\b[^>]*\blang\s*=/i.test(allContent)) {
    return [{ check: "lang_attr", file: "(project)", detail: "<html> element missing lang attribute", severity: "error" }];
  }
  return [];
}
function checkAutoplay(files) {
  const findings = [];
  for (const file of files) {
    if (/<(?:video|audio)\b[^>]*\bautoplay\b/i.test(file.content)) {
      findings.push({ check: "autoplay", file: file.relativePath, detail: "Auto-playing media without user control", severity: "warning" });
    }
  }
  return findings;
}
function checkSkipNav(files) {
  const allContent = files.map((f) => f.content).join("\n");
  if (/<main\b/i.test(allContent) && !/<a\b[^>]*href\s*=\s*["']#(?:main|content|skip)/i.test(allContent)) {
    return [{ check: "skip_nav", file: "(project)", detail: "No skip-to-content navigation link found", severity: "warning" }];
  }
  return [];
}
function runA11yCheck(check, files) {
  switch (check) {
    case "alt_text":
      return checkAltText(files);
    case "heading_hierarchy":
      return checkHeadingHierarchy(files);
    case "landmark":
      return checkLandmarks(files);
    case "aria_label":
      return checkAriaLabels(files);
    case "focus_management":
      return checkFocusManagement(files);
    case "color_contrast":
      return [];
    // Requires computed styles — deferred to browser gate
    case "form_labels":
      return checkFormLabels(files);
    case "link_text":
      return checkLinkText(files);
    case "lang_attr":
      return checkLangAttr(files);
    case "autoplay":
      return checkAutoplay(files);
    case "skip_nav":
      return checkSkipNav(files);
    default:
      return [];
  }
}
function runA11yGate(ctx) {
  const start = Date.now();
  const a11yPreds = ctx.predicates.filter((p) => p.type === "a11y");
  if (a11yPreds.length === 0) {
    return {
      gate: "a11y",
      passed: true,
      detail: "No a11y predicates to check",
      durationMs: Date.now() - start,
      predicateResults: []
    };
  }
  const scanDir = ctx.stageDir ?? ctx.config.appDir;
  const htmlFiles = readHTMLContent(scanDir);
  const results = [];
  let allPassed = true;
  const details = [];
  for (let i = 0; i < a11yPreds.length; i++) {
    const p = a11yPreds[i];
    const result = validateA11yPredicate(p, htmlFiles);
    results.push({ ...result, predicateId: `a11y_p${i}` });
    if (!result.passed) {
      allPassed = false;
      details.push(result.actual ?? "failed");
    }
  }
  const passCount = results.filter((r) => r.passed).length;
  const detail = allPassed ? `All ${a11yPreds.length} a11y predicates passed` : `${passCount}/${a11yPreds.length} passed: ${details.join("; ")}`;
  ctx.log(`[a11y] ${detail}`);
  return {
    gate: "a11y",
    passed: allPassed,
    detail,
    durationMs: Date.now() - start,
    predicateResults: results
  };
}
function validateA11yPredicate(p, files) {
  const check = p.a11yCheck;
  const fingerprint = `type=a11y|check=${check}`;
  if (!check) {
    return { type: "a11y", passed: false, expected: "a11y check type", actual: "(no a11yCheck specified)", fingerprint };
  }
  const expected = p.expected ?? "no_findings";
  const findings = runA11yCheck(check, files);
  if (expected === "no_findings" || expected === "clean" || expected === "pass") {
    const passed = findings.length === 0;
    return {
      type: "a11y",
      passed,
      expected: `${check}: no findings`,
      actual: passed ? `${check}: clean` : `${findings.length} finding(s): ${findings.slice(0, 3).map((f) => `${f.file}: ${f.detail}`).join("; ")}`,
      fingerprint
    };
  }
  if (expected === "has_findings" || expected === "fail") {
    const passed = findings.length > 0;
    return {
      type: "a11y",
      passed,
      expected: `${check}: has findings`,
      actual: passed ? `${findings.length} finding(s) detected` : `${check}: no findings (expected some)`,
      fingerprint
    };
  }
  return { type: "a11y", passed: false, expected, actual: `unknown expected value: ${expected}`, fingerprint };
}

// src/gates/performance.ts
var import_fs13 = require("fs");
var import_path13 = require("path");
function measureBundleSize(appDir) {
  const BUNDLE_EXTS = /* @__PURE__ */ new Set([".js", ".css", ".mjs", ".cjs"]);
  const SKIP = /* @__PURE__ */ new Set(["node_modules", ".git", ".next", "dist", ".sovereign", ".verify"]);
  const files = [];
  function scan(dir, rel) {
    try {
      const entries = (0, import_fs13.readdirSync)(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const fullPath = (0, import_path13.join)(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, rel ? `${rel}/${entry.name}` : entry.name);
        } else if (BUNDLE_EXTS.has((0, import_path13.extname)(entry.name).toLowerCase())) {
          try {
            const stats = (0, import_fs13.statSync)(fullPath);
            files.push({ path: rel ? `${rel}/${entry.name}` : entry.name, bytes: stats.size });
          } catch {
          }
        }
      }
    } catch {
    }
  }
  scan(appDir, "");
  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  return { totalBytes, files };
}
function checkImageOptimization(appDir) {
  const IMAGE_EXTS = /* @__PURE__ */ new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tiff"]);
  const MODERN_EXTS = /* @__PURE__ */ new Set([".webp", ".avif", ".svg"]);
  const SKIP = /* @__PURE__ */ new Set(["node_modules", ".git", ".next", "dist", ".sovereign", ".verify"]);
  const issues = [];
  let hasOldFormat = false;
  let hasModernFormat = false;
  function scan(dir, rel) {
    try {
      const entries = (0, import_fs13.readdirSync)(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const fullPath = (0, import_path13.join)(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, rel ? `${rel}/${entry.name}` : entry.name);
        } else {
          const ext = (0, import_path13.extname)(entry.name).toLowerCase();
          if (IMAGE_EXTS.has(ext)) {
            hasOldFormat = true;
            try {
              const stats = (0, import_fs13.statSync)(fullPath);
              if (stats.size > 500 * 1024) {
                issues.push({
                  file: rel ? `${rel}/${entry.name}` : entry.name,
                  issue: `Large image (${(stats.size / 1024).toFixed(0)}KB) \u2014 consider compression or modern format`
                });
              }
            } catch {
            }
          }
          if (MODERN_EXTS.has(ext)) {
            hasModernFormat = true;
          }
        }
      }
    } catch {
    }
  }
  scan(appDir, "");
  if (hasOldFormat && !hasModernFormat) {
    issues.push({ file: "(project)", issue: "No modern image formats (webp/avif/svg) found \u2014 consider converting" });
  }
  return issues;
}
function checkLazyLoading(appDir) {
  const issues = [];
  const SKIP = /* @__PURE__ */ new Set(["node_modules", ".git", ".next", "dist", ".sovereign", ".verify"]);
  function scan(dir, rel) {
    try {
      const entries = (0, import_fs13.readdirSync)(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const fullPath = (0, import_path13.join)(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, rel ? `${rel}/${entry.name}` : entry.name);
        } else {
          const ext = (0, import_path13.extname)(entry.name).toLowerCase();
          if ([".html", ".htm", ".jsx", ".tsx", ".js"].includes(ext)) {
            try {
              const content = (0, import_fs13.readFileSync)(fullPath, "utf-8");
              const imgRegex = /<img\b[^>]*>/gi;
              let match;
              while ((match = imgRegex.exec(content)) !== null) {
                const tag = match[0];
                if (!tag.includes("loading=") && !tag.includes("loading =")) {
                  issues.push({
                    file: rel ? `${rel}/${entry.name}` : entry.name,
                    issue: 'Image without loading="lazy" attribute'
                  });
                }
              }
            } catch {
            }
          }
        }
      }
    } catch {
    }
  }
  scan(appDir, "");
  return issues;
}
function countConnections(appDir) {
  const SKIP = /* @__PURE__ */ new Set(["node_modules", ".git", ".next", "dist", ".sovereign", ".verify"]);
  const externalRefs = /* @__PURE__ */ new Set();
  function scan(dir) {
    try {
      const entries = (0, import_fs13.readdirSync)(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const fullPath = (0, import_path13.join)(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath);
        } else {
          const ext = (0, import_path13.extname)(entry.name).toLowerCase();
          if ([".html", ".htm", ".js", ".ts", ".jsx", ".tsx"].includes(ext)) {
            try {
              const content = (0, import_fs13.readFileSync)(fullPath, "utf-8");
              const urlRegex = /(?:src|href|url)\s*=\s*['"]?(https?:\/\/[^'">\s]+)/gi;
              let match;
              while ((match = urlRegex.exec(content)) !== null) {
                try {
                  const host = new URL(match[1]).hostname;
                  externalRefs.add(host);
                } catch {
                }
              }
            } catch {
            }
          }
        }
      }
    } catch {
    }
  }
  scan(appDir);
  return { count: externalRefs.size, details: [...externalRefs] };
}
function checkUnminifiedAssets(appDir) {
  const BUNDLE_EXTS = /* @__PURE__ */ new Set([".js", ".css", ".mjs", ".cjs"]);
  const SKIP = /* @__PURE__ */ new Set(["node_modules", ".git", ".next", "dist", ".sovereign", ".verify"]);
  const issues = [];
  function scan(dir, rel) {
    try {
      const entries = (0, import_fs13.readdirSync)(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const fullPath = (0, import_path13.join)(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, rel ? `${rel}/${entry.name}` : entry.name);
        } else if (BUNDLE_EXTS.has((0, import_path13.extname)(entry.name).toLowerCase())) {
          if (/\.min\.(js|css)$/i.test(entry.name)) continue;
          try {
            const stats = (0, import_fs13.statSync)(fullPath);
            if (stats.size > 10 * 1024) {
              const content = (0, import_fs13.readFileSync)(fullPath, "utf-8");
              const lines = content.split("\n");
              const avgLineLen = content.length / Math.max(lines.length, 1);
              if (avgLineLen < 120) {
                issues.push({
                  file: rel ? `${rel}/${entry.name}` : entry.name,
                  issue: `Unminified asset (${(stats.size / 1024).toFixed(0)}KB, avg ${avgLineLen.toFixed(0)} chars/line)`
                });
              }
            }
          } catch {
          }
        }
      }
    } catch {
    }
  }
  scan(appDir, "");
  return issues;
}
function checkRenderBlocking(files) {
  const issues = [];
  for (const file of files) {
    const headMatch = file.content.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
    if (headMatch) {
      const headContent = headMatch[1];
      const scriptRegex = /<script\b[^>]*src\s*=[^>]*>/gi;
      let match;
      while ((match = scriptRegex.exec(headContent)) !== null) {
        const tag = match[0];
        if (!tag.includes("defer") && !tag.includes("async") && !tag.includes('type="module"')) {
          issues.push({ file: file.relativePath, issue: "Render-blocking script in <head> without defer/async" });
        }
      }
    }
    const linkRegex = /<link\b[^>]*rel\s*=\s*['"]stylesheet['"][^>]*>/gi;
    let linkMatch;
    while ((linkMatch = linkRegex.exec(file.content)) !== null) {
      const tag = linkMatch[0];
      if (tag.includes("href=") && /https?:\/\//.test(tag) && !tag.includes("media=")) {
        issues.push({ file: file.relativePath, issue: "External stylesheet without media attribute may block rendering" });
      }
    }
  }
  return issues;
}
function checkDomDepth(files) {
  const issues = [];
  const MAX_DEPTH = 15;
  for (const file of files) {
    let depth = 0;
    let maxDepth = 0;
    const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g;
    const VOID_ELEMENTS = /* @__PURE__ */ new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
    let match;
    while ((match = tagRegex.exec(file.content)) !== null) {
      const tag = match[0];
      const tagName = match[1].toLowerCase();
      if (VOID_ELEMENTS.has(tagName) || tag.endsWith("/>")) continue;
      if (tag.startsWith("</")) {
        depth = Math.max(0, depth - 1);
      } else {
        depth++;
        maxDepth = Math.max(maxDepth, depth);
      }
    }
    if (maxDepth > MAX_DEPTH) {
      issues.push({ file: file.relativePath, issue: `DOM depth ${maxDepth} exceeds recommended max of ${MAX_DEPTH}`, depth: maxDepth });
    }
  }
  return issues;
}
function checkCacheHeaders(files) {
  const issues = [];
  for (const file of files) {
    if (/\.(js|ts|mjs)$/i.test(file.relativePath)) {
      if (/express\.static|serve-static|sendFile|createReadStream/i.test(file.content)) {
        if (!/cache-control|maxAge|max-age|etag|last-modified/i.test(file.content)) {
          issues.push({ file: file.relativePath, issue: "Static file serving without cache headers configuration" });
        }
      }
    }
  }
  return issues;
}
function checkDuplicateDeps(appDir) {
  const issues = [];
  try {
    const pkgPath = (0, import_path13.join)(appDir, "package.json");
    if (!(0, import_fs13.existsSync)(pkgPath)) return issues;
    const pkg = JSON.parse((0, import_fs13.readFileSync)(pkgPath, "utf-8"));
    const deps = Object.keys(pkg.dependencies ?? {});
    const devDeps = Object.keys(pkg.devDependencies ?? {});
    const overlap = deps.filter((d) => devDeps.includes(d));
    for (const dep of overlap) {
      issues.push({ dep, issue: `"${dep}" appears in both dependencies and devDependencies` });
    }
    const DUPLICATE_GROUPS = [
      ["lodash", "underscore"],
      ["moment", "dayjs", "date-fns"],
      ["axios", "node-fetch", "got", "superagent"]
    ];
    const allDeps = /* @__PURE__ */ new Set([...deps, ...devDeps]);
    for (const group of DUPLICATE_GROUPS) {
      const found = group.filter((d) => allDeps.has(d));
      if (found.length > 1) {
        issues.push({ dep: found.join(", "), issue: `Duplicate utility libraries: ${found.join(", ")}` });
      }
    }
  } catch {
  }
  return issues;
}
function readHTMLFiles(appDir) {
  const files = [];
  const HTML_EXTS = /* @__PURE__ */ new Set([".html", ".htm", ".ejs", ".hbs", ".jsx", ".tsx", ".js", ".ts"]);
  const SKIP = /* @__PURE__ */ new Set(["node_modules", ".git", ".next", "dist", ".sovereign", ".verify"]);
  function scan(dir, rel) {
    try {
      const entries = (0, import_fs13.readdirSync)(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const fullPath = (0, import_path13.join)(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, rel ? `${rel}/${entry.name}` : entry.name);
        } else if (HTML_EXTS.has((0, import_path13.extname)(entry.name).toLowerCase())) {
          try {
            files.push({ relativePath: rel ? `${rel}/${entry.name}` : entry.name, content: (0, import_fs13.readFileSync)(fullPath, "utf-8") });
          } catch {
          }
        }
      }
    } catch {
    }
  }
  scan(appDir, "");
  return files;
}
function runPerformanceGate(ctx) {
  const start = Date.now();
  const perfPreds = ctx.predicates.filter((p) => p.type === "performance");
  if (perfPreds.length === 0) {
    return {
      gate: "performance",
      passed: true,
      detail: "No performance predicates to check",
      durationMs: Date.now() - start,
      predicateResults: []
    };
  }
  const results = [];
  let allPassed = true;
  const details = [];
  for (let i = 0; i < perfPreds.length; i++) {
    const p = perfPreds[i];
    const result = validatePerformancePredicate(p, ctx.stageDir ?? ctx.config.appDir);
    results.push({ ...result, predicateId: `perf_p${i}` });
    if (!result.passed) {
      allPassed = false;
      details.push(result.actual ?? "failed");
    }
  }
  const passCount = results.filter((r) => r.passed).length;
  const detail = allPassed ? `All ${perfPreds.length} performance predicates passed` : `${passCount}/${perfPreds.length} passed: ${details.join("; ")}`;
  ctx.log(`[performance] ${detail}`);
  return {
    gate: "performance",
    passed: allPassed,
    detail,
    durationMs: Date.now() - start,
    predicateResults: results
  };
}
function validatePerformancePredicate(p, appDir) {
  const check = p.perfCheck;
  const fingerprint = `type=performance|check=${check}|threshold=${p.threshold ?? "default"}`;
  if (!check) {
    return { type: "performance", passed: false, expected: "perf check type", actual: "(no perfCheck specified)", fingerprint };
  }
  switch (check) {
    case "bundle_size": {
      const threshold = p.threshold ?? 512 * 1024;
      const { totalBytes, files } = measureBundleSize(appDir);
      const passed = totalBytes <= threshold;
      return {
        type: "performance",
        passed,
        expected: `bundle size \u2264 ${formatBytes(threshold)}`,
        actual: `${formatBytes(totalBytes)} across ${files.length} files`,
        fingerprint
      };
    }
    case "image_optimization": {
      const issues = checkImageOptimization(appDir);
      const passed = issues.length === 0;
      return {
        type: "performance",
        passed,
        expected: "images optimized",
        actual: passed ? "all images optimized" : `${issues.length} issue(s): ${issues.slice(0, 3).map((i) => i.issue).join("; ")}`,
        fingerprint
      };
    }
    case "lazy_loading": {
      const issues = checkLazyLoading(appDir);
      const passed = issues.length === 0;
      return {
        type: "performance",
        passed,
        expected: "lazy loading on images",
        actual: passed ? "all images have lazy loading" : `${issues.length} image(s) without lazy loading`,
        fingerprint
      };
    }
    case "connection_count": {
      const threshold = p.threshold ?? 10;
      const { count, details } = countConnections(appDir);
      const passed = count <= threshold;
      return {
        type: "performance",
        passed,
        expected: `\u2264 ${threshold} external connections`,
        actual: `${count} external domain(s)${count > 0 ? `: ${details.slice(0, 5).join(", ")}` : ""}`,
        fingerprint
      };
    }
    case "response_time": {
      return {
        type: "performance",
        passed: true,
        expected: "response time check (runtime \u2014 deferred)",
        actual: "deferred to HTTP gate (requires running server)",
        fingerprint
      };
    }
    case "unminified_assets": {
      const issues = checkUnminifiedAssets(appDir);
      const passed = issues.length === 0;
      return {
        type: "performance",
        passed,
        expected: "assets minified",
        actual: passed ? "all assets appear minified" : `${issues.length} unminified asset(s): ${issues.slice(0, 3).map((i) => i.issue).join("; ")}`,
        fingerprint
      };
    }
    case "render_blocking": {
      const htmlFiles = readHTMLFiles(appDir);
      const issues = checkRenderBlocking(htmlFiles);
      const passed = issues.length === 0;
      return {
        type: "performance",
        passed,
        expected: "no render-blocking resources",
        actual: passed ? "no render-blocking resources detected" : `${issues.length} render-blocking issue(s): ${issues.slice(0, 3).map((i) => i.issue).join("; ")}`,
        fingerprint
      };
    }
    case "dom_depth": {
      const htmlFiles = readHTMLFiles(appDir);
      const depthIssues = checkDomDepth(htmlFiles);
      const passed = depthIssues.length === 0;
      return {
        type: "performance",
        passed,
        expected: "DOM depth \u2264 15",
        actual: passed ? "DOM depth within limits" : `${depthIssues.length} file(s) with excessive DOM depth: ${depthIssues.slice(0, 3).map((i) => `${i.file} (depth ${i.depth})`).join("; ")}`,
        fingerprint
      };
    }
    case "cache_headers": {
      const htmlFiles = readHTMLFiles(appDir);
      const issues = checkCacheHeaders(htmlFiles);
      const passed = issues.length === 0;
      return {
        type: "performance",
        passed,
        expected: "cache headers configured for static assets",
        actual: passed ? "cache headers configured" : `${issues.length} issue(s): ${issues.slice(0, 3).map((i) => i.issue).join("; ")}`,
        fingerprint
      };
    }
    case "duplicate_deps": {
      const issues = checkDuplicateDeps(appDir);
      const passed = issues.length === 0;
      return {
        type: "performance",
        passed,
        expected: "no duplicate dependencies",
        actual: passed ? "no duplicate dependencies found" : `${issues.length} issue(s): ${issues.slice(0, 3).map((i) => i.issue).join("; ")}`,
        fingerprint
      };
    }
    default:
      return { type: "performance", passed: false, expected: "valid perf check", actual: `unknown check: ${check}`, fingerprint };
  }
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// src/gates/access.ts
var import_fs14 = require("fs");
var import_path14 = require("path");
var DANGEROUS_SYSTEM_PATHS = [
  { regex: /\/etc\/(?:passwd|shadow|sudoers|hosts)/g, detail: "References sensitive system file" },
  { regex: /~\/\.ssh\//g, detail: "References SSH credentials directory" },
  { regex: /\/home\/[^/]+\/\.ssh\//g, detail: "References user SSH directory" },
  { regex: /\/proc\/self\//g, detail: "References /proc/self/ (process introspection)" },
  { regex: /C:\\Users\\[^\\]+\\\.ssh/gi, detail: "References Windows SSH directory" }
];
var USER_INPUT_PATTERN = /(?:req\.|params\.|body\.|query\.|args\.|process\.argv|request\.|ctx\.|context\.)/;
var FILE_OP_WITH_INPUT = /(?:readFile|readFileSync|writeFile|writeFileSync|createReadStream|createWriteStream|open|openSync|unlink|unlinkSync|stat|statSync|access|accessSync|exec|execSync|spawn)\s*\(\s*(?:req\.|params\.|body\.|query\.|args\.|process\.argv)/g;
var SYSTEM_PATH_PATTERNS = [
  { regex: /\/etc\//g, detail: "References /etc/ (system configuration)" },
  { regex: /\/var\/log\//g, detail: "References /var/log/ (system logs)" },
  { regex: /\/var\/run\//g, detail: "References /var/run/ (runtime state)" },
  { regex: /\/proc\//g, detail: "References /proc/ (kernel process info)" },
  { regex: /\/sys\//g, detail: "References /sys/ (kernel parameters)" },
  { regex: /\/root\//g, detail: "References /root/ (root home directory)" },
  { regex: /\/usr\/local\/bin\//g, detail: "References /usr/local/bin/ (system binaries)" },
  { regex: /\/tmp\//g, detail: "References /tmp/ (shared temporary directory)" },
  { regex: /C:\\Windows\\/gi, detail: "References C:\\Windows\\ (Windows system directory)" },
  { regex: /C:\\Program Files/gi, detail: "References C:\\Program Files (Windows programs)" }
];
var DOCKER_SOCKET_PATTERNS = [
  { regex: /\/var\/run\/docker\.sock/g, detail: "Docker socket access (container escape risk)" },
  { regex: /docker\.sock/g, detail: "Docker socket reference" }
];
var PERMISSION_PATTERNS = [
  { regex: /\bchmod\s+777\b/g, detail: "chmod 777 \u2014 world-writable permissions", severity: "warning" },
  { regex: /\bchmod\s+[0-7]*[67][0-7]{2}\b/g, detail: "chmod with overly permissive bits", severity: "warning" },
  { regex: /\bchown\s+root\b/g, detail: "chown root \u2014 changes file ownership to root", severity: "error" },
  { regex: /\bsudo\s+/g, detail: "sudo usage \u2014 requires elevated privileges", severity: "error" },
  { regex: /\bGRANT\s+ALL\b/gi, detail: "GRANT ALL \u2014 grants unrestricted database permissions", severity: "error" },
  { regex: /\bGRANT\s+SUPERUSER\b/gi, detail: "GRANT SUPERUSER \u2014 grants database superuser", severity: "error" },
  { regex: /\bALTER\s+ROLE\s+\w+\s+SUPERUSER\b/gi, detail: "ALTER ROLE SUPERUSER \u2014 elevates database role", severity: "error" }
];
var ENV_ESCALATION_PATTERNS = [
  { regex: /\bUSER\s+root\b/g, detail: "Dockerfile USER root \u2014 container runs as root", severity: "error" },
  { regex: /--privileged/g, detail: "--privileged flag \u2014 disables container isolation", severity: "error" },
  { regex: /--cap-add\s*=?\s*\w+/g, detail: "--cap-add \u2014 adds Linux capabilities to container", severity: "warning" },
  { regex: /cap_add:/g, detail: "cap_add in compose \u2014 adds Linux capabilities", severity: "warning" },
  { regex: /\bSYS_ADMIN\b/g, detail: "SYS_ADMIN capability \u2014 near-root access in container", severity: "error" },
  { regex: /\bSYS_PTRACE\b/g, detail: "SYS_PTRACE capability \u2014 process tracing access", severity: "warning" },
  { regex: /\bNET_ADMIN\b/g, detail: "NET_ADMIN capability \u2014 network configuration access", severity: "warning" },
  { regex: /\bNET_RAW\b/g, detail: "NET_RAW capability \u2014 raw socket access", severity: "warning" },
  { regex: /privileged:\s*true/g, detail: "privileged: true in compose \u2014 disables container isolation", severity: "error" },
  { regex: /security_opt:\s*\n?\s*-\s*seccomp:unconfined/g, detail: "seccomp:unconfined \u2014 disables syscall filtering", severity: "error" },
  { regex: /pid:\s*["']?host["']?/g, detail: "pid: host \u2014 shares host PID namespace", severity: "error" },
  { regex: /network_mode:\s*["']?host["']?/g, detail: "network_mode: host \u2014 container shares host network", severity: "warning" }
];
var PRIVILEGED_PORT_PATTERNS = [
  {
    regex: /(?:listen|port|PORT)\s*(?:=|:)\s*(\d+)/g,
    extract: (m) => parseInt(m[1], 10)
  },
  {
    regex: /\.listen\s*\(\s*(\d+)/g,
    extract: (m) => parseInt(m[1], 10)
  },
  {
    regex: /(?:ports|expose)\s*:\s*\n?\s*-\s*["']?(\d+):/gm,
    extract: (m) => parseInt(m[1], 10)
  },
  {
    regex: /-p\s+(\d+):/g,
    extract: (m) => parseInt(m[1], 10)
  }
];
function extractOrigin(url) {
  try {
    const u = new URL(url);
    return u.origin;
  } catch {
    return null;
  }
}
function detectCrossOrigin(pred, appDomain) {
  if (pred.path && /^https?:\/\//i.test(pred.path)) {
    const origin = extractOrigin(pred.path);
    if (origin && appDomain) {
      const appOrigin = extractOrigin(appDomain);
      if (appOrigin && origin !== appOrigin) {
        return origin;
      }
    }
    if (origin && !appDomain) {
      return origin;
    }
  }
  if (pred.steps) {
    for (const step of pred.steps) {
      if (/^https?:\/\//i.test(step.path)) {
        const origin = extractOrigin(step.path);
        if (origin) return origin;
      }
    }
  }
  return null;
}
function checkEditPathTraversal(edit, appDir) {
  const filePath = edit.file;
  if ((0, import_path14.isAbsolute)(filePath)) {
    return `Edit targets absolute path: ${filePath}`;
  }
  const normalized = (0, import_path14.normalize)(filePath);
  if (normalized.startsWith("..")) {
    return `Edit escapes app directory: ${filePath}`;
  }
  const resolved = (0, import_path14.resolve)(appDir, filePath);
  const resolvedAppDir = (0, import_path14.resolve)(appDir);
  if (!resolved.startsWith(resolvedAppDir)) {
    return `Edit resolves outside app directory: ${filePath} -> ${resolved}`;
  }
  return null;
}
var DOCKER_FILES = /* @__PURE__ */ new Set(["Dockerfile", "docker-compose.yml", "docker-compose.yaml", ".dockerignore"]);
function scanSystemPaths(files) {
  const violations = [];
  for (const file of files) {
    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;
      const hasUserInput = USER_INPUT_PATTERN.test(line);
      FILE_OP_WITH_INPUT.lastIndex = 0;
      if (FILE_OP_WITH_INPUT.test(line)) {
        violations.push({
          type: "path_traversal",
          severity: "error",
          file: file.relativePath,
          line: i + 1,
          detail: "User input in file operation (path traversal risk)"
        });
        continue;
      }
      for (const { regex, detail } of DANGEROUS_SYSTEM_PATHS) {
        regex.lastIndex = 0;
        if (regex.test(line)) {
          violations.push({
            type: "path_traversal",
            severity: hasUserInput ? "error" : "warning",
            file: file.relativePath,
            line: i + 1,
            detail: hasUserInput ? `${detail} \u2014 with user input (path traversal)` : `${detail} (hardcoded, low risk)`
          });
        }
      }
      if (hasUserInput) {
        for (const { regex, detail } of SYSTEM_PATH_PATTERNS) {
          regex.lastIndex = 0;
          if (regex.test(line)) {
            violations.push({
              type: "path_traversal",
              severity: "error",
              file: file.relativePath,
              line: i + 1,
              detail: `${detail} \u2014 with user input`
            });
          }
        }
      }
      for (const { regex, detail } of DOCKER_SOCKET_PATTERNS) {
        regex.lastIndex = 0;
        if (regex.test(line)) {
          violations.push({
            type: "permission_escalation",
            severity: "error",
            file: file.relativePath,
            line: i + 1,
            detail
          });
        }
      }
    }
  }
  return violations;
}
function scanPrivilegedPorts(files) {
  const violations = [];
  for (const file of files) {
    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i];
      for (const { regex, extract } of PRIVILEGED_PORT_PATTERNS) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(line)) !== null) {
          const port = extract(match);
          if (port !== null && port > 0 && port < 1024) {
            violations.push({
              type: "privileged_port",
              severity: "warning",
              file: file.relativePath,
              line: i + 1,
              detail: `Port ${port} requires root (ports below 1024 are privileged)`
            });
          }
        }
      }
    }
  }
  return violations;
}
function scanPermissionEscalation(files) {
  const violations = [];
  for (const file of files) {
    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;
      for (const { regex, detail, severity } of PERMISSION_PATTERNS) {
        regex.lastIndex = 0;
        if (regex.test(line)) {
          violations.push({
            type: "permission_escalation",
            severity,
            file: file.relativePath,
            line: i + 1,
            detail
          });
        }
      }
    }
  }
  return violations;
}
function scanEnvironmentEscalation(files) {
  const violations = [];
  const dockerFiles = files.filter((f) => {
    const name = f.relativePath.split("/").pop() ?? "";
    return DOCKER_FILES.has(name) || name.endsWith(".yml") || name.endsWith(".yaml");
  });
  for (const file of dockerFiles) {
    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i];
      for (const { regex, detail, severity } of ENV_ESCALATION_PATTERNS) {
        regex.lastIndex = 0;
        if (regex.test(line)) {
          violations.push({
            type: "environment_escalation",
            severity,
            file: file.relativePath,
            line: i + 1,
            detail
          });
        }
      }
    }
  }
  return violations;
}
function scanEditPaths(edits, appDir) {
  const violations = [];
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const traversal = checkEditPathTraversal(edit, appDir);
    if (traversal) {
      violations.push({
        type: "path_traversal",
        severity: "error",
        file: edit.file,
        line: 0,
        detail: traversal
      });
    }
    const content = edit.replace;
    for (const { regex, detail } of SYSTEM_PATH_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(content)) {
        violations.push({
          type: "path_traversal",
          severity: "error",
          file: edit.file,
          line: 0,
          detail: `Edit replacement introduces: ${detail}`
        });
      }
    }
    for (const { regex, detail } of DOCKER_SOCKET_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(content)) {
        violations.push({
          type: "permission_escalation",
          severity: "error",
          file: edit.file,
          line: 0,
          detail: `Edit replacement introduces: ${detail}`
        });
      }
    }
  }
  return violations;
}
function scanPredicateCrossOrigin(predicates, appUrl) {
  const violations = [];
  for (let i = 0; i < predicates.length; i++) {
    const pred = predicates[i];
    const foreignOrigin = detectCrossOrigin(pred, appUrl);
    if (foreignOrigin) {
      violations.push({
        type: "cross_origin",
        severity: "warning",
        file: `predicate[${i}]`,
        line: 0,
        detail: `Predicate references foreign origin: ${foreignOrigin}`
      });
    }
  }
  return violations;
}
function runAccessGate(ctx) {
  const start = Date.now();
  const violations = [];
  const baseDir = ctx.stageDir ?? ctx.config.appDir;
  const appUrl = ctx.config.appUrl ?? ctx.appUrl;
  violations.push(...scanEditPaths(ctx.edits, baseDir));
  violations.push(...scanPredicateCrossOrigin(ctx.predicates, appUrl));
  const sourceFiles = [];
  for (const edit of ctx.edits) {
    if (!edit.replace) continue;
    if (edit.file.endsWith(".d.ts") || edit.file.includes("types.ts") || edit.file.includes("types/")) continue;
    sourceFiles.push({
      relativePath: edit.file,
      content: edit.replace,
      lines: edit.replace.split("\n")
    });
  }
  violations.push(...scanSystemPaths(sourceFiles));
  violations.push(...scanPrivilegedPorts(sourceFiles));
  violations.push(...scanPermissionEscalation(sourceFiles));
  violations.push(...scanEnvironmentEscalation(sourceFiles));
  const errors = violations.filter((v) => v.severity === "error");
  const warnings = violations.filter((v) => v.severity === "warning");
  const passed = errors.length === 0;
  let detail;
  if (violations.length === 0) {
    detail = "No access violations detected";
  } else if (passed) {
    detail = `${warnings.length} warning(s): ${summarizeViolations(warnings)}`;
  } else {
    detail = `${errors.length} error(s), ${warnings.length} warning(s): ${summarizeViolations(errors)}`;
  }
  ctx.log(`[access] ${detail}`);
  return {
    gate: "access",
    passed,
    detail,
    durationMs: Date.now() - start,
    violations
  };
}
function summarizeViolations(violations) {
  const byType = /* @__PURE__ */ new Map();
  for (const v of violations) {
    byType.set(v.type, (byType.get(v.type) ?? 0) + 1);
  }
  const parts = [];
  for (const [type, count] of byType) {
    parts.push(`${count}\xD7 ${type.replace(/_/g, " ")}`);
  }
  return parts.join(", ");
}

// src/gates/temporal.ts
var import_fs15 = require("fs");
var import_path15 = require("path");
var SERVER_FILES = ["server.js", "server.ts", "app.js", "app.ts", "index.js", "index.ts", "main.js", "main.ts"];
var DOCKERFILE_NAMES = ["Dockerfile", "dockerfile"];
var COMPOSE_NAMES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
var ENV_NAMES = [".env", ".env.local", ".env.production", ".env.development"];
var DEPENDENCY_FILES = /* @__PURE__ */ new Set([
  "package.json",
  "package-lock.json",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  "requirements.txt",
  "Pipfile",
  "Pipfile.lock",
  "pyproject.toml",
  "poetry.lock",
  "go.mod",
  "go.sum",
  "Gemfile",
  "Gemfile.lock",
  "Cargo.toml",
  "Cargo.lock",
  "composer.json",
  "composer.lock"
]);
var BUILD_TRIGGER_FILES = /* @__PURE__ */ new Set([
  "Dockerfile",
  "dockerfile",
  ".dockerignore",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml"
]);
var PORT_PATTERNS_SOURCE = [
  /(?:const|let|var)\s+(?:PORT|port)\s*=\s*(\d+)/,
  /\.listen\(\s*(\d+)/,
  /process\.env\.PORT\s*\|\|\s*(\d+)/,
  /port:\s*(\d+)/
];
var EXPOSE_PATTERN = /^EXPOSE\s+(\d+)/m;
var COMPOSE_PORT_PATTERN = /['"]?(\d+):(\d+)['"]?/;
function runTemporalGate(ctx) {
  const start = Date.now();
  const baseDir = ctx.stageDir ?? ctx.config.appDir;
  const drifts = [];
  const editedFiles = new Set(ctx.edits.map((e) => e.file));
  drifts.push(...detectPortMismatch(baseDir, editedFiles));
  drifts.push(...detectConfigDivergence(baseDir, ctx.edits));
  drifts.push(...detectMissingRebuild(baseDir, editedFiles));
  drifts.push(...detectCrossFileReferences(baseDir, ctx.edits, editedFiles));
  drifts.push(...detectMigrationOrdering(baseDir, editedFiles));
  const errors = drifts.filter((d) => d.severity === "error");
  const warnings = drifts.filter((d) => d.severity === "warning");
  const passed = errors.length === 0;
  let detail;
  if (drifts.length === 0) {
    detail = "No temporal drifts detected";
  } else if (passed) {
    detail = `${warnings.length} temporal warning(s): ${warnings.map((w) => w.detail).join("; ")}`;
  } else {
    detail = `${errors.length} temporal error(s), ${warnings.length} warning(s): ` + errors.map((e) => e.detail).join("; ");
  }
  return {
    gate: "temporal",
    passed,
    detail,
    durationMs: Date.now() - start,
    drifts
  };
}
function detectPortMismatch(baseDir, editedFiles) {
  const drifts = [];
  if (!SERVER_FILES.some((f) => editedFiles.has(f))) return drifts;
  let sourcePort = null;
  let sourceFile = null;
  for (const name of SERVER_FILES) {
    const content = safeRead((0, import_path15.join)(baseDir, name));
    if (!content) continue;
    for (const pattern of PORT_PATTERNS_SOURCE) {
      const match = pattern.exec(content);
      if (match) {
        sourcePort = match[1];
        sourceFile = name;
        break;
      }
    }
    if (sourcePort) break;
  }
  if (!sourcePort || !sourceFile) return drifts;
  const dockerfileEdited = DOCKERFILE_NAMES.some((f) => editedFiles.has(f));
  const composeEdited = COMPOSE_NAMES.some((f) => editedFiles.has(f));
  if (dockerfileEdited) {
    for (const name of DOCKERFILE_NAMES) {
      if (!editedFiles.has(name)) continue;
      const content = safeRead((0, import_path15.join)(baseDir, name));
      if (!content) continue;
      const match = EXPOSE_PATTERN.exec(content);
      if (match && match[1] !== sourcePort) {
        drifts.push({
          type: "port_mismatch",
          severity: "error",
          sourceFile,
          staleFile: name,
          detail: `Port ${sourcePort} in ${sourceFile} but EXPOSE ${match[1]} in ${name}`,
          sourceValue: sourcePort,
          staleValue: match[1]
        });
      }
    }
  }
  if (composeEdited) {
    for (const name of COMPOSE_NAMES) {
      if (!editedFiles.has(name)) continue;
      const content = safeRead((0, import_path15.join)(baseDir, name));
      if (!content) continue;
      for (const line of extractComposePortLines(content)) {
        const match = COMPOSE_PORT_PATTERN.exec(line);
        if (match && match[2] !== sourcePort) {
          drifts.push({
            type: "port_mismatch",
            severity: "error",
            sourceFile,
            staleFile: name,
            detail: `Port ${sourcePort} in ${sourceFile} but container port ${match[2]} in ${name}`,
            sourceValue: sourcePort,
            staleValue: match[2]
          });
        }
      }
    }
  }
  return drifts;
}
function detectConfigDivergence(baseDir, edits) {
  const drifts = [];
  for (const edit of edits) {
    if (!ENV_NAMES.includes(edit.file)) continue;
    const searchLines = edit.search.split("\n");
    const replaceLines = edit.replace.split("\n");
    for (let i = 0; i < searchLines.length; i++) {
      const sMatch = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/.exec(searchLines[i]?.trim() ?? "");
      const rMatch = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/.exec(replaceLines[i]?.trim() ?? "");
      if (!sMatch || !rMatch || sMatch[1] !== rMatch[1]) continue;
      const varName = sMatch[1];
      const oldVal = sMatch[2].trim();
      const newVal = rMatch[2].trim();
      if (oldVal === newVal) continue;
      for (const srcName of SERVER_FILES) {
        const srcContent = safeRead((0, import_path15.join)(baseDir, srcName));
        if (!srcContent) continue;
        const re = new RegExp(
          `process\\.env\\.${varName}\\s*\\|\\|\\s*['"]?${escapeRegex(oldVal)}['"]?`
        );
        if (re.test(srcContent)) {
          drifts.push({
            type: "config_divergence",
            severity: "warning",
            sourceFile: edit.file,
            staleFile: srcName,
            detail: `${varName}=${newVal} in ${edit.file} but default still ${oldVal} in ${srcName}`,
            sourceValue: newVal,
            staleValue: oldVal
          });
        }
      }
    }
  }
  return drifts;
}
function detectMissingRebuild(baseDir, editedFiles) {
  const drifts = [];
  const editedDeps = [...editedFiles].filter((f) => DEPENDENCY_FILES.has((0, import_path15.basename)(f)));
  if (editedDeps.length === 0) return drifts;
  if ([...editedFiles].some((f) => BUILD_TRIGGER_FILES.has((0, import_path15.basename)(f)))) return drifts;
  let dockerfileName = "";
  let dockerfileContent = "";
  for (const name of DOCKERFILE_NAMES) {
    const content = safeRead((0, import_path15.join)(baseDir, name));
    if (content) {
      dockerfileName = name;
      dockerfileContent = content;
      break;
    }
  }
  if (!dockerfileName) return drifts;
  for (const depFile of editedDeps) {
    const depBase = (0, import_path15.basename)(depFile);
    const copyPattern = new RegExp(`COPY\\s+.*${escapeRegex(depBase)}`, "i");
    if (copyPattern.test(dockerfileContent) || /COPY\s+\.\s/i.test(dockerfileContent)) {
      drifts.push({
        type: "missing_rebuild",
        severity: "error",
        sourceFile: depFile,
        staleFile: dockerfileName,
        detail: `${depFile} changed but no build trigger file edited \u2014 Docker cache may serve stale deps`,
        sourceValue: "modified",
        staleValue: "unchanged (needs --no-cache or Dockerfile touch)"
      });
    }
  }
  return drifts;
}
function detectCrossFileReferences(baseDir, edits, editedFiles) {
  const drifts = [];
  const renames = [];
  for (const edit of edits) {
    const oldRoutes = extractRoutes3(edit.search);
    const newRoutes = extractRoutes3(edit.replace);
    for (const oldR of oldRoutes) {
      if (!newRoutes.includes(oldR) && newRoutes.length > 0) {
        renames.push({ old: oldR, replacement: newRoutes[0], file: edit.file });
      }
    }
    const oldIds = extractIdentifiers(edit.search);
    const newIds = extractIdentifiers(edit.replace);
    for (const oldId of oldIds) {
      if (oldId.length < 4 || edit.replace.includes(oldId)) continue;
      const candidate = newIds.find((n) => !edit.search.includes(n));
      if (candidate) {
        renames.push({ old: oldId, replacement: candidate, file: edit.file });
      }
    }
  }
  if (renames.length === 0) return drifts;
  const scannableFiles = collectScannable(baseDir, editedFiles);
  for (const { old: oldToken, replacement, file: srcFile } of renames) {
    for (const { relative, content } of scannableFiles) {
      if (editedFiles.has(relative)) continue;
      if (content.includes(oldToken)) {
        drifts.push({
          type: "cross_file_reference",
          severity: "warning",
          sourceFile: srcFile,
          staleFile: relative,
          detail: `"${oldToken}" renamed to "${replacement}" in ${srcFile} but still referenced in ${relative}`,
          sourceValue: replacement,
          staleValue: oldToken
        });
      }
    }
  }
  return drifts;
}
function detectMigrationOrdering(baseDir, editedFiles) {
  const drifts = [];
  const editedMigrations = [...editedFiles].filter(
    (f) => f.startsWith("migrations/") || f.startsWith("migrations\\")
  );
  if (editedMigrations.length === 0) return drifts;
  const migrationsDir = (0, import_path15.join)(baseDir, "migrations");
  let migrationFiles = [];
  try {
    migrationFiles = (0, import_fs15.readdirSync)(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    return drifts;
  }
  const knownTables = /* @__PURE__ */ new Set();
  const initContent = safeRead((0, import_path15.join)(baseDir, "init.sql"));
  if (initContent) {
    for (const t of extractCreatedTables(initContent)) knownTables.add(t.toLowerCase());
  }
  for (const migFile of migrationFiles) {
    const content = safeRead((0, import_path15.join)(migrationsDir, migFile));
    if (!content) continue;
    const relative = `migrations/${migFile}`;
    const isEdited = editedMigrations.some(
      (f) => f === relative || f.endsWith(`/${migFile}`) || f.endsWith(`\\${migFile}`)
    );
    if (isEdited) {
      for (const ref of extractReferencedTables(content)) {
        if (!knownTables.has(ref.toLowerCase())) {
          drifts.push({
            type: "migration_ordering",
            severity: "error",
            sourceFile: relative,
            staleFile: relative,
            detail: `${migFile} references table "${ref}" not created by any prior migration or init.sql`,
            sourceValue: `REFERENCES ${ref}`,
            staleValue: `table "${ref}" not found`
          });
        }
      }
      for (const table of extractAlteredTables(content)) {
        if (!knownTables.has(table.toLowerCase())) {
          drifts.push({
            type: "migration_ordering",
            severity: "error",
            sourceFile: relative,
            staleFile: relative,
            detail: `${migFile} alters table "${table}" not created by any prior migration or init.sql`,
            sourceValue: `ALTER TABLE ${table}`,
            staleValue: `table "${table}" not found`
          });
        }
      }
    }
    for (const t of extractCreatedTables(content)) knownTables.add(t.toLowerCase());
  }
  return drifts;
}
function safeRead(path) {
  try {
    return (0, import_fs15.existsSync)(path) ? (0, import_fs15.readFileSync)(path, "utf-8") : null;
  } catch {
    return null;
  }
}
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function extractRoutes3(code) {
  const routes = [];
  const re = /['"`](\/[a-zA-Z0-9/_:-]+)['"`]/g;
  let m;
  while ((m = re.exec(code)) !== null) routes.push(m[1]);
  return routes;
}
function extractIdentifiers(code) {
  const ids = [];
  const re = /(?:function|const|let|var|class)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
  let m;
  while ((m = re.exec(code)) !== null) ids.push(m[1]);
  return ids;
}
function extractCreatedTables(sql) {
  const tables = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?/gi;
  let m;
  while ((m = re.exec(sql)) !== null) tables.push(m[1]);
  return tables;
}
function extractReferencedTables(sql) {
  const seen = /* @__PURE__ */ new Set();
  const tables = [];
  const patterns = [
    /REFERENCES\s+["']?(\w+)["']?/gi,
    /FOREIGN\s+KEY\s*\([^)]+\)\s*REFERENCES\s+["']?(\w+)["']?/gi
  ];
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, "gi");
    let m;
    while ((m = re.exec(sql)) !== null) {
      const name = m[1].toLowerCase();
      if (!seen.has(name)) {
        seen.add(name);
        tables.push(m[1]);
      }
    }
  }
  return tables;
}
function extractAlteredTables(sql) {
  const tables = [];
  const re = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["']?(\w+)["']?/gi;
  let m;
  while ((m = re.exec(sql)) !== null) tables.push(m[1]);
  return tables;
}
function extractComposePortLines(content) {
  const lines = content.split("\n");
  const portLines = [];
  let inPorts = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^ports:\s*$/i.test(trimmed)) {
      inPorts = true;
      continue;
    }
    if (/^ports:\s*\[/i.test(trimmed)) {
      portLines.push(trimmed);
      continue;
    }
    if (inPorts) {
      if (trimmed.startsWith("-")) portLines.push(trimmed);
      else if (trimmed.length > 0 && !trimmed.startsWith("#")) inPorts = false;
    }
  }
  return portLines;
}
function collectScannable(baseDir, editedFiles) {
  const results = [];
  const SKIP = /* @__PURE__ */ new Set(["node_modules", ".git", ".next", "dist", "build", ".cache", "__pycache__"]);
  const TEXT_EXTS2 = /* @__PURE__ */ new Set([
    ".js",
    ".ts",
    ".jsx",
    ".tsx",
    ".mjs",
    ".cjs",
    ".json",
    ".yml",
    ".yaml",
    ".toml",
    ".sql",
    ".md",
    ".txt",
    ".html",
    ".css",
    ".env",
    ".py",
    ".rb",
    ".go",
    ".rs",
    ".sh"
  ]);
  function scan(dir, prefix, depth) {
    if (depth > 3) return;
    let entries;
    try {
      entries = (0, import_fs15.readdirSync)(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry) || entry.startsWith(".") && !ENV_NAMES.includes(entry)) continue;
      const full = (0, import_path15.join)(dir, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      try {
        (0, import_fs15.readdirSync)(full);
        scan(full, relative, depth + 1);
        continue;
      } catch {
      }
      const ext = (0, import_path15.extname)(entry).toLowerCase();
      if (TEXT_EXTS2.has(ext) || DOCKERFILE_NAMES.includes(entry) || ENV_NAMES.includes(entry)) {
        const content = safeRead(full);
        if (content && content.length < 5e5) results.push({ relative, content });
      }
    }
  }
  scan(baseDir, "", 0);
  return results;
}

// src/gates/propagation.ts
var import_fs16 = require("fs");
var import_path16 = require("path");
var SOURCE_EXTS = /* @__PURE__ */ new Set([
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".mjs",
  ".cjs",
  ".html",
  ".htm",
  ".ejs",
  ".hbs",
  ".pug",
  ".vue",
  ".svelte",
  ".astro"
]);
var SQL_FILES = ["init.sql", "schema.sql", "seed.sql"];
var ENV_NAMES2 = [".env", ".env.local", ".env.production", ".env.development", ".env.example"];
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", ".next", "dist", "build", ".cache", "__pycache__", ".verify"]);
var TEXT_EXTS = /* @__PURE__ */ new Set([
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yml",
  ".yaml",
  ".sql",
  ".html",
  ".htm",
  ".css",
  ".env",
  ".ejs",
  ".hbs",
  ".pug",
  ".vue",
  ".svelte",
  ".astro",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".sh"
]);
function runPropagationGate(ctx) {
  const start = Date.now();
  const baseDir = ctx.stageDir ?? ctx.config.appDir;
  const breaks = [];
  const editedFiles = new Set(ctx.edits.map((e) => e.file));
  breaks.push(...detectCSSClassOrphans(baseDir, ctx.edits));
  breaks.push(...detectRouteReferenceStale(baseDir, ctx.edits, editedFiles));
  breaks.push(...detectSchemaQueryMismatch(baseDir, ctx.edits, editedFiles));
  breaks.push(...detectEnvKeyDivergence(baseDir, ctx.edits, editedFiles));
  breaks.push(...detectImportPathBroken(baseDir, ctx.edits, editedFiles));
  const errors = breaks.filter((b) => b.severity === "error");
  const warnings = breaks.filter((b) => b.severity === "warning");
  const passed = errors.length === 0;
  let detail;
  if (breaks.length === 0) {
    detail = "No propagation breaks detected";
  } else if (passed) {
    detail = `${warnings.length} propagation warning(s): ${warnings.map((w) => w.detail).join("; ")}`;
  } else {
    detail = `${errors.length} propagation error(s), ${warnings.length} warning(s): ` + errors.map((e) => e.detail).join("; ");
  }
  return {
    gate: "propagation",
    passed,
    detail,
    durationMs: Date.now() - start,
    breaks
  };
}
function detectCSSClassOrphans(baseDir, edits) {
  const breaks = [];
  for (const edit of edits) {
    if (!looksLikeCSS(edit.search) && !looksLikeCSS(edit.replace)) continue;
    const oldClasses = extractCSSClassNames(edit.search);
    const newClasses = extractCSSClassNames(edit.replace);
    for (const oldClass of oldClasses) {
      if (newClasses.has(oldClass)) continue;
      if (oldClass.length < 2) continue;
      const fullPath = (0, import_path16.join)(baseDir, edit.file);
      const content = safeRead2(fullPath);
      if (!content) continue;
      const htmlClassPattern = new RegExp(
        `class\\s*=\\s*["'][^"']*\\b${escapeRegex2(oldClass)}\\b[^"']*["']`
      );
      if (htmlClassPattern.test(content)) {
        const replacement = findLikelyReplacement(oldClass, newClasses);
        breaks.push({
          type: "css_class_orphan",
          severity: "error",
          sourceFile: edit.file,
          downstreamFile: edit.file,
          detail: `CSS class ".${oldClass}" renamed${replacement ? ` to ".${replacement}"` : ""} in <style> but HTML still uses class="${oldClass}"`,
          oldValue: oldClass,
          newValue: replacement ?? "(removed)"
        });
      }
      const scannableFiles = collectScannableFiles(baseDir, /* @__PURE__ */ new Set([edit.file]));
      for (const { relative, content: fileContent } of scannableFiles) {
        if (relative === edit.file) continue;
        const refPattern = new RegExp(
          `class\\s*=\\s*["'][^"']*\\b${escapeRegex2(oldClass)}\\b[^"']*["']`
        );
        if (refPattern.test(fileContent)) {
          const replacement = findLikelyReplacement(oldClass, newClasses);
          breaks.push({
            type: "css_class_orphan",
            severity: "error",
            sourceFile: edit.file,
            downstreamFile: relative,
            detail: `CSS class ".${oldClass}" renamed in ${edit.file} but ${relative} still uses class="${oldClass}"`,
            oldValue: oldClass,
            newValue: replacement ?? "(removed)"
          });
        }
      }
    }
  }
  return breaks;
}
function detectRouteReferenceStale(baseDir, edits, editedFiles) {
  const breaks = [];
  for (const edit of edits) {
    const oldRoutes = extractRouteDefinitions(edit.search);
    const newRoutes = extractRouteDefinitions(edit.replace);
    for (const oldRoute of oldRoutes) {
      if (newRoutes.includes(oldRoute)) continue;
      if (oldRoute === "/" || oldRoute === "*") continue;
      const replacement = newRoutes.length > 0 ? newRoutes[0] : null;
      const scannableFiles = collectScannableFiles(baseDir, /* @__PURE__ */ new Set());
      for (const { relative, content } of scannableFiles) {
        if (relative === edit.file && !content.includes(oldRoute)) continue;
        const staleRefs = findRouteReferences(content, oldRoute);
        if (staleRefs.length > 0) {
          breaks.push({
            type: "route_reference_stale",
            severity: "warning",
            sourceFile: edit.file,
            downstreamFile: relative,
            detail: `Route "${oldRoute}" changed${replacement ? ` to "${replacement}"` : ""} in ${edit.file} but ${relative} still references "${oldRoute}" (${staleRefs.join(", ")})`,
            oldValue: oldRoute,
            newValue: replacement ?? "(removed)"
          });
        }
      }
    }
  }
  return breaks;
}
function detectSchemaQueryMismatch(baseDir, edits, editedFiles) {
  const breaks = [];
  for (const edit of edits) {
    const fileName = (0, import_path16.basename)(edit.file);
    const isSQLFile = SQL_FILES.includes(fileName) || edit.file.startsWith("migrations/") || edit.file.startsWith("migrations\\") || fileName.endsWith(".sql");
    if (!isSQLFile) continue;
    const oldColumns = extractColumnNames(edit.search);
    const newColumns = extractColumnNames(edit.replace);
    for (const oldCol of oldColumns) {
      if (newColumns.has(oldCol)) continue;
      if (oldCol.length < 2) continue;
      if (isReservedSQLWord(oldCol)) continue;
      const scannableFiles = collectScannableFiles(baseDir, /* @__PURE__ */ new Set());
      for (const { relative, content } of scannableFiles) {
        if (relative === edit.file) continue;
        if (!isSourceFile(relative)) continue;
        const queryRefs = findColumnInQueries(content, oldCol);
        if (queryRefs.length > 0) {
          const replacement = findLikelyColumnReplacement(oldCol, newColumns);
          breaks.push({
            type: "schema_query_mismatch",
            severity: "error",
            sourceFile: edit.file,
            downstreamFile: relative,
            detail: `Column "${oldCol}" changed in ${edit.file} but ${relative} still references it in ${queryRefs[0]}`,
            oldValue: oldCol,
            newValue: replacement ?? "(removed)"
          });
        }
      }
    }
  }
  return breaks;
}
function detectEnvKeyDivergence(baseDir, edits, editedFiles) {
  const breaks = [];
  for (const edit of edits) {
    const oldKeys = extractEnvKeys(edit.search);
    const newKeys = extractEnvKeys(edit.replace);
    if (oldKeys.length === 0) continue;
    for (const oldKey of oldKeys) {
      if (newKeys.includes(oldKey)) continue;
      if (oldKey.length < 2) continue;
      const replacement = newKeys.find((k) => !oldKeys.includes(k)) ?? null;
      const scannableFiles = collectScannableFiles(baseDir, /* @__PURE__ */ new Set());
      for (const { relative, content } of scannableFiles) {
        if (relative === edit.file) continue;
        const consumers = findEnvConsumers(content, oldKey);
        if (consumers.length > 0) {
          breaks.push({
            type: "env_key_divergence",
            severity: "warning",
            sourceFile: edit.file,
            downstreamFile: relative,
            detail: `Env var "${oldKey}" renamed${replacement ? ` to "${replacement}"` : ""} in ${edit.file} but ${relative} still references "${oldKey}" (${consumers[0]})`,
            oldValue: oldKey,
            newValue: replacement ?? "(removed)"
          });
        }
      }
    }
  }
  return breaks;
}
function detectImportPathBroken(baseDir, edits, editedFiles) {
  const breaks = [];
  for (const edit of edits) {
    const oldImports = extractImportPaths(edit.search);
    const newImports = extractImportPaths(edit.replace);
    for (const oldPath of oldImports) {
      if (newImports.includes(oldPath)) continue;
      if (oldPath.startsWith("node:") || !oldPath.startsWith(".")) continue;
      const replacement = newImports.find((p) => p.startsWith(".") && !oldImports.includes(p)) ?? null;
      const resolvedOld = resolveImportPath(baseDir, edit.file, oldPath);
      if (resolvedOld && (0, import_fs16.existsSync)(resolvedOld)) continue;
      const scannableFiles = collectScannableFiles(baseDir, /* @__PURE__ */ new Set());
      for (const { relative, content } of scannableFiles) {
        if (relative === edit.file) continue;
        if (content.includes(oldPath)) {
          const importRefs = findImportReferences(content, oldPath);
          if (importRefs.length > 0) {
            breaks.push({
              type: "import_path_broken",
              severity: "error",
              sourceFile: edit.file,
              downstreamFile: relative,
              detail: `Import path "${oldPath}" changed${replacement ? ` to "${replacement}"` : ""} in ${edit.file} but ${relative} still imports "${oldPath}"`,
              oldValue: oldPath,
              newValue: replacement ?? "(removed)"
            });
          }
        }
      }
    }
  }
  return breaks;
}
function extractCSSClassNames(text) {
  const classes = /* @__PURE__ */ new Set();
  const re = /\.([a-zA-Z_-][a-zA-Z0-9_-]*)\s*[{,:]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    classes.add(m[1]);
  }
  return classes;
}
function looksLikeCSS(text) {
  return /[.#][a-zA-Z_-][a-zA-Z0-9_-]*\s*\{/.test(text) || /<style[\s>]/.test(text);
}
function findLikelyReplacement(oldClass, newClasses) {
  for (const nc of newClasses) {
    if (nc === oldClass) continue;
    const shorter = oldClass.length <= nc.length ? oldClass : nc;
    for (let len = shorter.length; len >= 3; len--) {
      for (let start = 0; start <= shorter.length - len; start++) {
        const sub = shorter.substring(start, start + len);
        if (oldClass.includes(sub) && nc.includes(sub)) return nc;
      }
    }
  }
  return newClasses.size === 1 ? [...newClasses][0] : null;
}
function extractRouteDefinitions(text) {
  const routes = [];
  const patterns = [
    // Express/Hono/Koa style: app.get('/path', ...) or router.post('/path', ...)
    /(?:app|router|server)\s*\.\s*(?:get|post|put|delete|patch|use|all|route)\s*\(\s*['"`](\/[a-zA-Z0-9/_:-]*)['"`]/g,
    // Vanilla HTTP: url.pathname === '/path' or req.url === '/path'
    /(?:url\.pathname|req\.url|request\.url)\s*===?\s*['"`](\/[a-zA-Z0-9/_:-]*)['"`]/g,
    // Next.js/file-based: export const route = '/path'
    /(?:route|path|endpoint)\s*[:=]\s*['"`](\/[a-zA-Z0-9/_:-]*)['"`]/g
  ];
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m;
    while ((m = re.exec(text)) !== null) routes.push(m[1]);
  }
  return [...new Set(routes)];
}
function findRouteReferences(content, route) {
  const refs = [];
  const escaped = escapeRegex2(route);
  const patterns = [
    { re: new RegExp(`href\\s*=\\s*["']${escaped}["']`, "g"), label: "href" },
    { re: new RegExp(`fetch\\s*\\(\\s*["'\`]${escaped}["'\`]`, "g"), label: "fetch()" },
    { re: new RegExp(`url:\\s*["'\`]${escaped}["'\`]`, "g"), label: "url property" },
    { re: new RegExp(`action\\s*=\\s*["']${escaped}["']`, "g"), label: "form action" },
    { re: new RegExp(`redirect\\s*\\(\\s*["'\`]${escaped}["'\`]`, "g"), label: "redirect()" },
    { re: new RegExp(`window\\.location(?:\\.href)?\\s*=\\s*["'\`]${escaped}["'\`]`, "g"), label: "window.location" }
  ];
  for (const { re, label } of patterns) {
    if (re.test(content)) refs.push(label);
  }
  return refs;
}
function extractColumnNames(sql) {
  const columns = /* @__PURE__ */ new Set();
  const createMatch = /CREATE\s+TABLE[^(]*\(([^)]+)\)/gi;
  let m;
  while ((m = createMatch.exec(sql)) !== null) {
    const body = m[1];
    for (const line of body.split(",")) {
      const colMatch = line.trim().match(/^["']?(\w+)["']?\s+\w/);
      if (colMatch && !isReservedSQLWord(colMatch[1])) {
        columns.add(colMatch[1]);
      }
    }
  }
  const alterAddRe = /ADD\s+(?:COLUMN\s+)?["']?(\w+)["']?\s+\w/gi;
  while ((m = alterAddRe.exec(sql)) !== null) {
    if (!isReservedSQLWord(m[1])) columns.add(m[1]);
  }
  const renameColRe = /RENAME\s+COLUMN\s+["']?(\w+)["']?\s+TO\s+["']?(\w+)["']?/gi;
  while ((m = renameColRe.exec(sql)) !== null) {
    if (!isReservedSQLWord(m[1])) columns.add(m[1]);
    if (!isReservedSQLWord(m[2])) columns.add(m[2]);
  }
  return columns;
}
function findColumnInQueries(content, column) {
  const refs = [];
  const escaped = escapeRegex2(column);
  const patterns = [
    { re: new RegExp(`SELECT\\b[^;]*\\b${escaped}\\b`, "gi"), label: "SELECT" },
    { re: new RegExp(`INSERT\\s+INTO\\s+\\w+\\s*\\([^)]*\\b${escaped}\\b`, "gi"), label: "INSERT" },
    { re: new RegExp(`UPDATE\\b[^;]*\\bSET\\b[^;]*\\b${escaped}\\b`, "gi"), label: "UPDATE" },
    { re: new RegExp(`WHERE\\b[^;]*\\b${escaped}\\b`, "gi"), label: "WHERE" },
    { re: new RegExp(`ORDER\\s+BY\\b[^;]*\\b${escaped}\\b`, "gi"), label: "ORDER BY" },
    { re: new RegExp(`GROUP\\s+BY\\b[^;]*\\b${escaped}\\b`, "gi"), label: "GROUP BY" }
  ];
  for (const { re, label } of patterns) {
    if (re.test(content)) {
      refs.push(label);
      break;
    }
  }
  return refs;
}
function findLikelyColumnReplacement(oldCol, newColumns) {
  for (const nc of newColumns) {
    if (nc === oldCol) continue;
    return nc;
  }
  return null;
}
function extractEnvKeys(text) {
  const keys = [];
  const envLineRe = /^([A-Z_][A-Z0-9_]*)\s*=(?!=)/gm;
  let m;
  while ((m = envLineRe.exec(text)) !== null) keys.push(m[1]);
  const processEnvRe = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
  while ((m = processEnvRe.exec(text)) !== null) {
    if (!keys.includes(m[1])) keys.push(m[1]);
  }
  const metaEnvRe = /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g;
  while ((m = metaEnvRe.exec(text)) !== null) {
    if (!keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}
function findEnvConsumers(content, key) {
  const consumers = [];
  const escaped = escapeRegex2(key);
  const patterns = [
    { re: new RegExp(`process\\.env\\.${escaped}\\b`), label: "process.env" },
    { re: new RegExp(`import\\.meta\\.env\\.${escaped}\\b`), label: "import.meta.env" },
    { re: new RegExp(`os\\.environ(?:\\.get)?\\s*\\(?\\s*['"]${escaped}['"]`), label: "os.environ" },
    { re: new RegExp(`\\$\\{${escaped}\\}`), label: "template interpolation" },
    { re: new RegExp(`^${escaped}\\s*=`, "m"), label: "env definition" }
  ];
  for (const { re, label } of patterns) {
    if (re.test(content)) {
      consumers.push(label);
      break;
    }
  }
  return consumers;
}
function extractImportPaths(text) {
  const paths = [];
  const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = requireRe.exec(text)) !== null) paths.push(m[1]);
  const importRe = /import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
  while ((m = importRe.exec(text)) !== null) paths.push(m[1]);
  const dynImportRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynImportRe.exec(text)) !== null) paths.push(m[1]);
  return [...new Set(paths)];
}
function findImportReferences(content, importPath) {
  const refs = [];
  const escaped = escapeRegex2(importPath);
  if (new RegExp(`require\\s*\\(\\s*['"]${escaped}['"]\\s*\\)`).test(content)) {
    refs.push("require()");
  }
  if (new RegExp(`import\\s+(?:.*?\\s+from\\s+)?['"]${escaped}['"]`).test(content)) {
    refs.push("import");
  }
  if (new RegExp(`import\\s*\\(\\s*['"]${escaped}['"]\\s*\\)`).test(content)) {
    refs.push("dynamic import()");
  }
  return refs;
}
function resolveImportPath(baseDir, fromFile, importPath) {
  const fromDir = (0, import_path16.dirname)((0, import_path16.join)(baseDir, fromFile));
  const resolved = (0, import_path16.join)(fromDir, importPath);
  const candidates = [
    resolved,
    resolved + ".js",
    resolved + ".ts",
    resolved + ".jsx",
    resolved + ".tsx",
    resolved + ".mjs",
    resolved + ".cjs",
    (0, import_path16.join)(resolved, "index.js"),
    (0, import_path16.join)(resolved, "index.ts")
  ];
  for (const candidate of candidates) {
    if ((0, import_fs16.existsSync)(candidate)) return candidate;
  }
  return null;
}
function isReservedSQLWord(word) {
  const reserved = /* @__PURE__ */ new Set([
    "primary",
    "key",
    "not",
    "null",
    "default",
    "unique",
    "check",
    "foreign",
    "references",
    "constraint",
    "index",
    "create",
    "table",
    "alter",
    "drop",
    "insert",
    "into",
    "values",
    "select",
    "from",
    "where",
    "update",
    "set",
    "delete",
    "and",
    "or",
    "in",
    "on",
    "if",
    "exists",
    "true",
    "false",
    "integer",
    "text",
    "varchar",
    "boolean",
    "timestamp",
    "serial",
    "bigint",
    "smallint",
    "real",
    "float",
    "double",
    "decimal",
    "numeric",
    "date",
    "time",
    "json",
    "jsonb",
    "uuid",
    "bytea",
    "char",
    "int",
    "cascade",
    "restrict",
    "action",
    "now",
    "current_timestamp",
    "add",
    "column",
    "rename",
    "to",
    "with",
    "as",
    "like",
    "between"
  ]);
  return reserved.has(word.toLowerCase());
}
function isSourceFile(filePath) {
  const ext = (0, import_path16.extname)(filePath).toLowerCase();
  return SOURCE_EXTS.has(ext);
}
function safeRead2(path) {
  try {
    return (0, import_fs16.existsSync)(path) ? (0, import_fs16.readFileSync)(path, "utf-8") : null;
  } catch {
    return null;
  }
}
function escapeRegex2(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function collectScannableFiles(baseDir, excludeFiles) {
  const results = [];
  function scan(dir, prefix, depth) {
    if (depth > 3) return;
    let entries;
    try {
      entries = (0, import_fs16.readdirSync)(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry.startsWith(".") && !ENV_NAMES2.includes(entry)) continue;
      const full = (0, import_path16.join)(dir, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      try {
        (0, import_fs16.readdirSync)(full);
        scan(full, relative, depth + 1);
        continue;
      } catch {
      }
      if (excludeFiles.has(relative)) continue;
      const ext = (0, import_path16.extname)(entry).toLowerCase();
      if (TEXT_EXTS.has(ext) || ENV_NAMES2.includes(entry)) {
        const content = safeRead2(full);
        if (content && content.length < 5e5) results.push({ relative, content });
      }
    }
  }
  scan(baseDir, "", 0);
  return results;
}

// src/gates/state.ts
var import_fs17 = require("fs");
var import_path17 = require("path");
var SCHEMA_FILES = ["init.sql", "schema.sql", "setup.sql"];
var MIGRATION_DIRS = ["migrations", "db/migrations", "sql/migrations"];
var ENV_FILES = [".env", ".env.local", ".env.production", ".env.development", ".env.example", ".env.test"];
var SKIP_DIRS2 = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".sovereign",
  ".verify",
  ".cache",
  "__pycache__",
  "coverage",
  ".nyc_output"
]);
var CODE_EXTS = /* @__PURE__ */ new Set([
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go"
]);
var NODE_BUILTINS = /* @__PURE__ */ new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib"
  // node: prefix handled separately
]);
var CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi;
var SQL_TABLE_PATTERNS = [
  { regex: /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi, label: "CREATE TABLE" },
  { regex: /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi, label: "ALTER TABLE" },
  { regex: /INSERT\s+INTO\s+["'`]?(\w+)["'`]?/gi, label: "INSERT INTO" },
  { regex: /SELECT\s+.+?\s+FROM\s+["'`]?(\w+)["'`]?/gi, label: "SELECT FROM" },
  { regex: /UPDATE\s+["'`]?(\w+)["'`]?\s+SET/gi, label: "UPDATE" },
  { regex: /DELETE\s+FROM\s+["'`]?(\w+)["'`]?/gi, label: "DELETE FROM" },
  { regex: /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi, label: "DROP TABLE" },
  { regex: /TRUNCATE\s+(?:TABLE\s+)?["'`]?(\w+)["'`]?/gi, label: "TRUNCATE" }
];
var ENV_REF_PATTERNS = [
  // JavaScript/TypeScript: process.env.VAR_NAME
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  // Python: os.environ['VAR_NAME'] or os.environ.get('VAR_NAME')
  /os\.environ(?:\.get)?\s*\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  /os\.environ\.get\s*\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  // Ruby: ENV['VAR_NAME'] or ENV.fetch('VAR_NAME')
  /ENV\s*\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  /ENV\.fetch\s*\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  // Go: os.Getenv("VAR_NAME")
  /os\.Getenv\s*\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g
];
var IMPLICIT_ENV_VARS = /* @__PURE__ */ new Set([
  "NODE_ENV",
  "HOME",
  "USER",
  "PATH",
  "PWD",
  "SHELL",
  "LANG",
  "TERM",
  "HOSTNAME",
  "PORT",
  "HOST",
  // Docker-injected
  "DOCKER_HOST"
]);
var IMPORT_PATTERNS = [
  // CommonJS: require('module') or require("module")
  /\brequire\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g,
  // ESM: import ... from 'module' or import ... from "module"
  /\bimport\s+(?:[\w{},*\s]+\s+from\s+)?['"]([^'"./][^'"]*)['"]/g,
  // Dynamic import: import('module')
  /\bimport\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g
];
function safeRead3(filePath) {
  try {
    return (0, import_fs17.existsSync)(filePath) ? (0, import_fs17.readFileSync)(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}
function collectSourceFiles(baseDir, extensions, maxDepth = 3) {
  const results = [];
  function scan(dir, prefix, depth) {
    if (depth > maxDepth) return;
    let names;
    try {
      names = (0, import_fs17.readdirSync)(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP_DIRS2.has(name)) continue;
      const fullPath = (0, import_path17.join)(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      try {
        const stat = (0, import_fs17.statSync)(fullPath);
        if (stat.isDirectory()) {
          scan(fullPath, relative, depth + 1);
        } else {
          const ext = (0, import_path17.extname)(name).toLowerCase();
          if (extensions.has(ext)) {
            const content = safeRead3(fullPath);
            if (content && content.length < 5e5) {
              results.push({ relative, content });
            }
          }
        }
      } catch {
        continue;
      }
    }
  }
  scan(baseDir, "", 0);
  return results;
}
function collectKnownTables(baseDir) {
  const tables = /* @__PURE__ */ new Set();
  for (const name of SCHEMA_FILES) {
    const content = safeRead3((0, import_path17.join)(baseDir, name));
    if (content) {
      extractTableNames(content, tables);
    }
  }
  for (const migDir of MIGRATION_DIRS) {
    const fullDir = (0, import_path17.join)(baseDir, migDir);
    try {
      const files = (0, import_fs17.readdirSync)(fullDir).filter((f) => f.endsWith(".sql")).sort();
      for (const file of files) {
        const content = safeRead3((0, import_path17.join)(fullDir, file));
        if (content) {
          extractTableNames(content, tables);
        }
      }
    } catch {
    }
  }
  return tables;
}
function extractTableNames(sql, tables) {
  const re = new RegExp(CREATE_TABLE_RE.source, "gi");
  let match;
  while ((match = re.exec(sql)) !== null) {
    tables.add(match[1].toLowerCase());
  }
}
function collectDefinedEnvVars(baseDir) {
  const vars = /* @__PURE__ */ new Set();
  for (const envFile of ENV_FILES) {
    const content = safeRead3((0, import_path17.join)(baseDir, envFile));
    if (!content) continue;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = /^([A-Z_][A-Z0-9_]*)\s*=/.exec(trimmed);
      if (match) {
        vars.add(match[1]);
      }
    }
  }
  const composeNames = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
  for (const name of composeNames) {
    const content = safeRead3((0, import_path17.join)(baseDir, name));
    if (!content) continue;
    const envRe = /^\s+-\s+([A-Z_][A-Z0-9_]*)=/gm;
    let match;
    while ((match = envRe.exec(content)) !== null) {
      vars.add(match[1]);
    }
    const envMapRe = /^\s+([A-Z_][A-Z0-9_]*):\s/gm;
    while ((match = envMapRe.exec(content)) !== null) {
      vars.add(match[1]);
    }
  }
  return vars;
}
function collectPackageDeps(baseDir) {
  const content = safeRead3((0, import_path17.join)(baseDir, "package.json"));
  if (!content) return null;
  try {
    const pkg = JSON.parse(content);
    const deps = /* @__PURE__ */ new Set();
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const section = pkg[field];
      if (section && typeof section === "object") {
        for (const name of Object.keys(section)) {
          deps.add(name);
        }
      }
    }
    return deps;
  } catch {
    return null;
  }
}
function isBuiltinModule(specifier) {
  if (specifier.startsWith("node:")) return true;
  if (NODE_BUILTINS.has(specifier)) return true;
  const base = specifier.split("/")[0];
  if (NODE_BUILTINS.has(base)) return true;
  return false;
}
function extractPackageName(specifier) {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split("/")[0];
}
function detectFileExistence(baseDir, edits) {
  const divergences = [];
  for (const edit of edits) {
    const targetPath = (0, import_path17.join)(baseDir, edit.file);
    if (!edit.search || edit.search.trim() === "") continue;
    if (!(0, import_fs17.existsSync)(targetPath)) {
      divergences.push({
        type: "file_existence",
        severity: "error",
        file: edit.file,
        detail: `Edit targets "${edit.file}" but file does not exist in workspace`,
        assumed: `File "${edit.file}" exists`,
        actual: "File not found"
      });
    }
  }
  return divergences;
}
function detectSelectorPresence(baseDir, predicates) {
  const divergences = [];
  for (const pred of predicates) {
    if (pred.type !== "css" || !pred.selector) continue;
    const filesToCheck = resolvePredicateFiles(baseDir, pred);
    for (const { relative, content } of filesToCheck) {
      const selectorBase = extractSelectorBase(pred.selector);
      if (selectorBase && !content.includes(selectorBase)) {
        divergences.push({
          type: "selector_presence",
          severity: "warning",
          file: relative,
          detail: `CSS predicate references selector "${pred.selector}" not found in "${relative}"`,
          assumed: `Selector "${pred.selector}" exists in source`,
          actual: `Selector base "${selectorBase}" not found in file`
        });
      }
    }
  }
  return divergences;
}
function extractSelectorBase(selector) {
  const trimmed = selector.trim();
  if (/^[a-z]+$/i.test(trimmed)) return null;
  if (trimmed === "*") return null;
  const segments = trimmed.split(/[\s>+~]+/);
  const last = segments[segments.length - 1].trim();
  const classMatch = /(\.[a-zA-Z_-][a-zA-Z0-9_-]*)/.exec(last);
  if (classMatch) return classMatch[1];
  const idMatch = /(#[a-zA-Z_-][a-zA-Z0-9_-]*)/.exec(last);
  if (idMatch) return idMatch[1];
  const pseudoStripped = last.replace(/:[a-z-]+(\([^)]*\))?/g, "");
  const classFromStripped = /(\.[a-zA-Z_-][a-zA-Z0-9_-]*)/.exec(pseudoStripped);
  if (classFromStripped) return classFromStripped[1];
  return null;
}
function resolvePredicateFiles(baseDir, pred) {
  const results = [];
  if (pred.file) {
    const content = safeRead3((0, import_path17.join)(baseDir, pred.file));
    if (content) {
      results.push({ relative: pred.file, content });
    }
    return results;
  }
  const styleExts = /* @__PURE__ */ new Set([".html", ".htm", ".css", ".js", ".ts", ".jsx", ".tsx", ".ejs", ".hbs", ".vue", ".svelte"]);
  return collectSourceFiles(baseDir, styleExts, 2);
}
function detectSchemaAssumption(baseDir, edits) {
  const divergences = [];
  const knownTables = collectKnownTables(baseDir);
  if (knownTables.size === 0) return divergences;
  const editCreatedTables = /* @__PURE__ */ new Set();
  for (const edit of edits) {
    const content = edit.replace || "";
    const re = new RegExp(CREATE_TABLE_RE.source, "gi");
    let match;
    while ((match = re.exec(content)) !== null) {
      editCreatedTables.add(match[1].toLowerCase());
    }
  }
  const allKnownTables = /* @__PURE__ */ new Set([...knownTables, ...editCreatedTables]);
  const SQL_RESERVED = /* @__PURE__ */ new Set([
    "select",
    "from",
    "where",
    "insert",
    "into",
    "update",
    "delete",
    "create",
    "table",
    "alter",
    "drop",
    "index",
    "view",
    "trigger",
    "function",
    "procedure",
    "begin",
    "end",
    "commit",
    "rollback",
    "set",
    "values",
    "null",
    "not",
    "and",
    "or",
    "in",
    "exists",
    "join",
    "left",
    "right",
    "inner",
    "outer",
    "on",
    "as",
    "if",
    "then",
    "else",
    "case",
    "when",
    "order",
    "by",
    "group",
    "having",
    "limit",
    "offset",
    "union",
    "all",
    "distinct",
    "true",
    "false",
    "primary",
    "key",
    "foreign",
    "references",
    "constraint",
    "unique",
    "default",
    "check",
    "cascade",
    "restrict",
    "serial",
    "text",
    "integer",
    "bigint",
    "varchar",
    "boolean",
    "timestamp",
    "date",
    "json",
    "jsonb",
    "uuid",
    "float",
    "double",
    "decimal",
    "numeric"
  ]);
  for (const edit of edits) {
    const content = edit.replace || "";
    for (const { regex, label } of SQL_TABLE_PATTERNS) {
      const re = new RegExp(regex.source, "gi");
      let match;
      while ((match = re.exec(content)) !== null) {
        const tableName = match[1];
        const tableNameLower = tableName.toLowerCase();
        if (SQL_RESERVED.has(tableNameLower)) continue;
        if (allKnownTables.has(tableNameLower)) continue;
        if (label === "CREATE TABLE") continue;
        divergences.push({
          type: "schema_assumption",
          severity: "warning",
          file: edit.file,
          detail: `${label} references table "${tableName}" not found in schema files`,
          assumed: `Table "${tableName}" exists in database`,
          actual: `Table not defined in init.sql or migrations (known: ${[...knownTables].join(", ") || "none"})`
        });
      }
    }
  }
  const seen = /* @__PURE__ */ new Set();
  return divergences.filter((d) => {
    const key = `${d.file}:${d.assumed}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function detectEnvAssumption(baseDir, edits) {
  const divergences = [];
  const definedVars = collectDefinedEnvVars(baseDir);
  const flaggedVars = /* @__PURE__ */ new Set();
  for (const edit of edits) {
    const content = edit.replace || "";
    for (const pattern of ENV_REF_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = re.exec(content)) !== null) {
        const varName = match[1];
        if (IMPLICIT_ENV_VARS.has(varName)) continue;
        if (definedVars.has(varName)) continue;
        const key = `${edit.file}:${varName}`;
        if (flaggedVars.has(key)) continue;
        flaggedVars.add(key);
        divergences.push({
          type: "env_assumption",
          severity: "warning",
          file: edit.file,
          detail: `References process.env.${varName} but "${varName}" not found in any .env file`,
          assumed: `Environment variable "${varName}" is defined`,
          actual: `Not found in ${ENV_FILES.join(", ")} or docker-compose environment`
        });
      }
    }
  }
  return divergences;
}
function detectDependencyAssumption(baseDir, edits) {
  const divergences = [];
  const deps = collectPackageDeps(baseDir);
  if (deps === null) return divergences;
  const flaggedModules = /* @__PURE__ */ new Set();
  for (const edit of edits) {
    const content = edit.replace || "";
    const ext = (0, import_path17.extname)(edit.file).toLowerCase();
    if (!CODE_EXTS.has(ext) && ext !== "") continue;
    for (const pattern of IMPORT_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = re.exec(content)) !== null) {
        const specifier = match[1];
        if (isBuiltinModule(specifier)) continue;
        const packageName = extractPackageName(specifier);
        if (deps.has(packageName)) continue;
        const key = `${edit.file}:${packageName}`;
        if (flaggedModules.has(key)) continue;
        flaggedModules.add(key);
        divergences.push({
          type: "dependency_assumption",
          severity: "warning",
          file: edit.file,
          detail: `Imports "${specifier}" but "${packageName}" not found in package.json dependencies`,
          assumed: `Module "${packageName}" is installed`,
          actual: `Not listed in package.json (dependencies, devDependencies, peerDependencies, or optionalDependencies)`
        });
      }
    }
  }
  return divergences;
}
function runStateGate(ctx) {
  const start = Date.now();
  const divergences = [];
  const baseDir = ctx.stageDir ?? ctx.config.appDir;
  divergences.push(...detectFileExistence(baseDir, ctx.edits));
  divergences.push(...detectSelectorPresence(baseDir, ctx.predicates));
  divergences.push(...detectSchemaAssumption(baseDir, ctx.edits));
  divergences.push(...detectEnvAssumption(baseDir, ctx.edits));
  divergences.push(...detectDependencyAssumption(baseDir, ctx.edits));
  const errors = divergences.filter((d) => d.severity === "error");
  const warnings = divergences.filter((d) => d.severity === "warning");
  const passed = errors.length === 0;
  let detail;
  if (divergences.length === 0) {
    detail = "No state assumption divergences detected";
  } else if (passed) {
    detail = `${warnings.length} state warning(s): ${summarizeDivergences(warnings)}`;
  } else {
    detail = `${errors.length} state error(s), ${warnings.length} warning(s): ${summarizeDivergences(errors)}`;
  }
  ctx.log(`[state] ${detail}`);
  return {
    gate: "state",
    passed,
    detail,
    durationMs: Date.now() - start,
    divergences
  };
}
function summarizeDivergences(divergences) {
  const byType = /* @__PURE__ */ new Map();
  for (const d of divergences) {
    byType.set(d.type, (byType.get(d.type) ?? 0) + 1);
  }
  const parts = [];
  for (const [type, count] of byType) {
    parts.push(`${count}x ${type.replace(/_/g, " ")}`);
  }
  return parts.join(", ");
}

// src/gates/capacity.ts
var import_fs18 = require("fs");
var import_path18 = require("path");
function isComment(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("--") || trimmed.startsWith("/*");
}
var SELECT_FROM_PATTERN = /\bSELECT\b[\s\S]*?\bFROM\b/gi;
var LIMIT_PATTERN = /\b(?:LIMIT|TOP|FETCH\s+FIRST)\b/i;
var INSERT_UPDATE_DELETE = /\b(?:INSERT|UPDATE|DELETE)\b/i;
function scanUnboundedQueries(lines, file) {
  const violations = [];
  const content = lines.join("\n");
  SELECT_FROM_PATTERN.lastIndex = 0;
  let match;
  while ((match = SELECT_FROM_PATTERN.exec(content)) !== null) {
    const matchStart = match.index;
    const stmtEnd = Math.min(content.length, matchStart + 500);
    let endIdx = stmtEnd;
    for (let i = matchStart; i < stmtEnd; i++) {
      if (content[i] === ";" || content[i] === "`") {
        endIdx = i + 1;
        break;
      }
    }
    const fullStmt = content.slice(matchStart, endIdx);
    const prefixStart = Math.max(0, matchStart - 30);
    const prefix = content.slice(prefixStart, matchStart);
    if (INSERT_UPDATE_DELETE.test(prefix)) continue;
    if (LIMIT_PATTERN.test(fullStmt)) continue;
    if (/\bSELECT\s+COUNT\s*\(/i.test(fullStmt)) continue;
    if (/\bEXISTS\s*\(\s*SELECT\b/i.test(fullStmt)) continue;
    if (/\bSELECT\s+1\b/i.test(fullStmt)) continue;
    if (/\bWHERE\b/i.test(fullStmt)) continue;
    const linesBefore = content.slice(0, matchStart).split("\n");
    const lineNum = linesBefore.length;
    if (lineNum > 0 && lineNum <= lines.length && isComment(lines[lineNum - 1])) continue;
    violations.push({
      type: "unbounded_query",
      severity: "error",
      file,
      line: lineNum,
      detail: `SELECT without LIMIT \u2014 potential full table scan: ${fullStmt.slice(0, 80).replace(/\n/g, " ").trim()}...`
    });
  }
  return violations;
}
var ROUTE_HANDLER_PATTERN = /\b(?:app|router|server)\s*\.\s*(?:get|post|put|delete|patch|all)\s*\(\s*['"`]/gim;
var DB_CALL_PATTERN = /\b(?:query|findAll|findMany|\.find\s*\(|\.select\s*\(|SELECT\s+.*\s+FROM|pool\.query|client\.query|db\.query|knex|prisma\.|sequelize\.|mongoose\.)/i;
var PAGINATION_KEYWORDS = /\b(?:limit|offset|page|cursor|skip|take|paginate|per_page|pageSize|perPage)\b/i;
function scanMissingPagination(lines, file) {
  const violations = [];
  const content = lines.join("\n");
  ROUTE_HANDLER_PATTERN.lastIndex = 0;
  let match;
  while ((match = ROUTE_HANDLER_PATTERN.exec(content)) !== null) {
    const matchStart = match.index;
    const bodyEnd = Math.min(content.length, matchStart + 2e3);
    const handlerBody = content.slice(matchStart, bodyEnd);
    if (!DB_CALL_PATTERN.test(handlerBody)) continue;
    if (PAGINATION_KEYWORDS.test(handlerBody)) continue;
    const linesBefore = content.slice(0, matchStart).split("\n");
    const lineNum = linesBefore.length;
    const routeMatch = handlerBody.match(/['"`]([^'"`]+)['"`]/);
    const routePath = routeMatch ? routeMatch[1] : "(unknown)";
    violations.push({
      type: "missing_pagination",
      severity: "warning",
      file,
      line: lineNum,
      detail: `Route handler "${routePath}" returns DB results without pagination (no limit/offset/cursor)`
    });
  }
  return violations;
}
function scanMemoryAccumulation(lines, file) {
  const violations = [];
  const moduleVars = /* @__PURE__ */ new Map();
  const moduleArrays = /* @__PURE__ */ new Set();
  const moduleMapsSets = /* @__PURE__ */ new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line)) continue;
    const trimmed = line.trim();
    const arrayDecl = trimmed.match(/^(?:const|let|var)\s+(\w+)\s*=\s*\[\s*\]/);
    if (arrayDecl && line.length - trimmed.length < 4) {
      moduleArrays.add(arrayDecl[1]);
      moduleVars.set(arrayDecl[1], i + 1);
    }
    const mapSetDecl = trimmed.match(/^(?:const|let|var)\s+(\w+)\s*=\s*new\s+(?:Map|Set)\s*\(/);
    if (mapSetDecl && line.length - trimmed.length < 4) {
      moduleMapsSets.add(mapSetDecl[1]);
      moduleVars.set(mapSetDecl[1], i + 1);
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line)) continue;
    const trimmed = line.trim();
    for (const arrName of moduleArrays) {
      const pushPattern = new RegExp(`\\b${arrName}\\.push\\s*\\(`);
      if (pushPattern.test(trimmed)) {
        const contextStart = Math.max(0, i - 5);
        const contextEnd = Math.min(lines.length, i + 5);
        const context = lines.slice(contextStart, contextEnd).join("\n");
        const hasBound = /\b(?:splice|shift|pop|slice|length\s*[<>=]|\.length\s*>\s*\d)/.test(context);
        if (!hasBound) {
          violations.push({
            type: "memory_accumulation",
            severity: "warning",
            file,
            line: i + 1,
            detail: `Module-level array "${arrName}" grows via .push() without bounds checking`
          });
        }
      }
    }
    for (const mapName of moduleMapsSets) {
      const setPattern = new RegExp(`\\b${mapName}\\.(?:set|add)\\s*\\(`);
      if (setPattern.test(trimmed)) {
        const fullContent = lines.join("\n");
        const hasEviction = new RegExp(`\\b${mapName}\\.(?:delete|clear)\\s*\\(`).test(fullContent);
        if (!hasEviction) {
          violations.push({
            type: "memory_accumulation",
            severity: "warning",
            file,
            line: i + 1,
            detail: `Module-level Map/Set "${mapName}" grows via .set()/.add() without eviction (.delete()/.clear())`
          });
          moduleMapsSets.delete(mapName);
        }
      }
    }
    if (/\+=\s*['"`]/.test(trimmed) || /\+=\s*\w/.test(trimmed)) {
      let depth = 0;
      let inLoop = false;
      for (let j = i; j >= Math.max(0, i - 30); j--) {
        const prev = lines[j].trim();
        if (prev.includes("}")) depth++;
        if (prev.includes("{")) depth--;
        if (depth <= 0 && /^\s*(?:for|while|do)\s*[({]/.test(prev)) {
          inLoop = true;
          break;
        }
      }
      if (inLoop && /\b(?:body|html|result|response|output|data)\s*\+=/.test(trimmed)) {
        violations.push({
          type: "memory_accumulation",
          severity: "warning",
          file,
          line: i + 1,
          detail: "String concatenation in loop \u2014 potential unbounded memory growth"
        });
      }
    }
  }
  return violations;
}
var FS_WRITE_PATTERN = /\b(?:writeFile|appendFile|writeFileSync|appendFileSync|createWriteStream)\s*\(/;
var RECURRING_PATTERN = /\b(?:setInterval|setImmediate|cron\.|schedule\.|\.schedule\s*\()/;
var ROTATION_KEYWORDS = /\b(?:rotate|maxSize|maxFiles|truncate|unlink|rename|stat|size\s*[<>=])/i;
function scanDiskGrowth(lines, file) {
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line)) continue;
    if (!FS_WRITE_PATTERN.test(line)) continue;
    let inLoopOrRecurring = false;
    for (let j = i; j >= Math.max(0, i - 30); j--) {
      const prev = lines[j].trim();
      if (/^\s*(?:for|while|do)\s*[({]/.test(prev) || RECURRING_PATTERN.test(prev)) {
        inLoopOrRecurring = true;
        break;
      }
    }
    if (!inLoopOrRecurring) continue;
    const contextStart = Math.max(0, i - 10);
    const contextEnd = Math.min(lines.length, i + 10);
    const context = lines.slice(contextStart, contextEnd).join("\n");
    if (ROTATION_KEYWORDS.test(context)) continue;
    violations.push({
      type: "disk_growth",
      severity: "warning",
      file,
      line: i + 1,
      detail: "File write inside loop/interval without rotation or size check"
    });
  }
  return violations;
}
var CONNECTION_PATTERN = /\b(?:new\s+Pool|createPool|createConnection|createClient|new\s+Client|mysql\.create|pg\.connect)\s*\(/;
function scanConnectionExhaustion(lines, file) {
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line)) continue;
    if (!CONNECTION_PATTERN.test(line)) continue;
    let inRouteHandler = false;
    let depth = 0;
    for (let j = i; j >= Math.max(0, i - 40); j--) {
      const prev = lines[j];
      for (const ch of prev) {
        if (ch === "}") depth++;
        if (ch === "{") depth--;
      }
      if (depth <= 0 && ROUTE_HANDLER_PATTERN.test(prev)) {
        inRouteHandler = true;
        break;
      }
      ROUTE_HANDLER_PATTERN.lastIndex = 0;
    }
    if (!inRouteHandler) continue;
    const contextEnd = Math.min(lines.length, i + 20);
    const context = lines.slice(i, contextEnd).join("\n");
    const hasRelease = /\.(?:release|end|close|destroy|disconnect|quit)\s*\(/.test(context);
    if (hasRelease) continue;
    violations.push({
      type: "connection_exhaustion",
      severity: "warning",
      file,
      line: i + 1,
      detail: "Database/Redis connection created inside request handler \u2014 will exhaust connection pool"
    });
  }
  return violations;
}
var CODE_EXTS2 = /* @__PURE__ */ new Set([
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".java",
  ".sql"
]);
function runCapacityGate(ctx) {
  const start = Date.now();
  const violations = [];
  const baseDir = ctx.stageDir ?? ctx.config.appDir;
  for (const edit of ctx.edits) {
    if (!edit.replace) continue;
    const ext = edit.file.includes(".") ? "." + edit.file.split(".").pop().toLowerCase() : "";
    if (!CODE_EXTS2.has(ext)) continue;
    const lines = edit.replace.split("\n");
    violations.push(...scanUnboundedQueries(lines, edit.file));
    violations.push(...scanMissingPagination(lines, edit.file));
    violations.push(...scanMemoryAccumulation(lines, edit.file));
    violations.push(...scanDiskGrowth(lines, edit.file));
    violations.push(...scanConnectionExhaustion(lines, edit.file));
  }
  const errors = violations.filter((v) => v.severity === "error");
  const warnings = violations.filter((v) => v.severity === "warning");
  const passed = errors.length === 0;
  let detail;
  if (violations.length === 0) {
    detail = "No capacity violations detected";
  } else if (passed) {
    detail = `${warnings.length} warning(s): ${summarizeViolations2(warnings)}`;
  } else {
    detail = `${errors.length} error(s), ${warnings.length} warning(s): ${summarizeViolations2(errors)}`;
  }
  ctx.log(`[capacity] ${detail}`);
  return {
    gate: "capacity",
    passed,
    detail,
    durationMs: Date.now() - start,
    violations
  };
}
function summarizeViolations2(violations) {
  const byType = /* @__PURE__ */ new Map();
  for (const v of violations) {
    byType.set(v.type, (byType.get(v.type) ?? 0) + 1);
  }
  const parts = [];
  for (const [type, count] of byType) {
    parts.push(`${count}\xD7 ${type.replace(/_/g, " ")}`);
  }
  return parts.join(", ");
}

// src/gates/contention.ts
var import_fs19 = require("fs");
var import_path19 = require("path");
function isComment2(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("#");
}
function extractFunctionBodies(lines) {
  const spans = [];
  const FUNC_RE = /(?:(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)\s*=>|\w+\s*=>)|(\w+)\s*\([^)]*\)\s*\{)/;
  for (let i = 0; i < lines.length; i++) {
    const match = FUNC_RE.exec(lines[i]);
    if (!match) continue;
    const name = match[1] || match[2] || match[3] || "anonymous";
    let braceStart = -1;
    for (let j = i; j < Math.min(i + 3, lines.length); j++) {
      if (lines[j].indexOf("{") !== -1) {
        braceStart = j;
        break;
      }
    }
    if (braceStart === -1) continue;
    let depth = 0, endLine = -1;
    for (let j = braceStart; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
      }
      if (depth === 0) {
        endLine = j;
        break;
      }
    }
    if (endLine === -1) endLine = lines.length - 1;
    const bodyLines = lines.slice(i, endLine + 1);
    spans.push({ name, startLine: i, endLine, body: bodyLines.join("\n"), bodyLines });
  }
  return spans;
}
var READ_PATTERNS = [
  /\b(?:GET|get|hget|hgetall)\s*\(/,
  /\bSELECT\b/i,
  /\breadFileSync\s*\(/,
  /\breadFile\s*\(/,
  /\.get\s*\(/,
  /await\s+\w+\.findOne\s*\(/,
  /await\s+\w+\.find\s*\(/
];
var WRITE_PATTERNS = [
  /\b(?:SET|set|hset|hmset)\s*\(/,
  /\bUPDATE\b/i,
  /\bINSERT\b/i,
  /\bwriteFileSync\s*\(/,
  /\bwriteFile\s*\(/,
  /\.set\s*\(/,
  /\.save\s*\(/,
  /await\s+\w+\.update\s*\(/
];
var ATOMICITY_PATTERNS = [
  /\btransaction\b/i,
  /\bWATCH\b/,
  /\block\b/i,
  /\bmutex\b/i,
  /\batomic\b/i,
  /\bcompareAndSwap\b/,
  /\bcompareAndSet\b/,
  /\bBEGIN\b/,
  /\bsemaphore\b/i,
  /\bsynchronized\b/i,
  /\.multi\s*\(/,
  /\.pipeline\s*\(/,
  /\bINCR\b/,
  /\bDECR\b/,
  /\bincrby\b/i
];
function detectRaceConditions(files) {
  const issues = [];
  for (const file of files) {
    for (const fn of extractFunctionBodies(file.lines)) {
      if (ATOMICITY_PATTERNS.some((p) => p.test(fn.body))) continue;
      let firstRead = -1, writeAfterRead = -1;
      for (let i = 0; i < fn.bodyLines.length; i++) {
        if (isComment2(fn.bodyLines[i])) continue;
        const isRead = READ_PATTERNS.some((p) => p.test(fn.bodyLines[i]));
        const isWrite = WRITE_PATTERNS.some((p) => p.test(fn.bodyLines[i]));
        if (isRead && firstRead === -1) firstRead = fn.startLine + i;
        if (isWrite && firstRead !== -1) {
          writeAfterRead = fn.startLine + i;
          break;
        }
      }
      if (firstRead !== -1 && writeAfterRead !== -1) {
        issues.push({
          type: "race_condition",
          severity: "error",
          file: file.relativePath,
          line: firstRead + 1,
          detail: `Read-modify-write without atomicity in ${fn.name}() \u2014 read at line ${firstRead + 1}, write at line ${writeAfterRead + 1} with no transaction/lock/mutex between them`
        });
      }
    }
  }
  return issues;
}
var MODULE_MUTABLE_DECL = /^(?:let|var)\s+(\w+)\s*=/;
var HANDLER_PATTERNS = [
  /(?:app|router)\s*\.\s*(?:get|post|put|delete|patch|use|all)\s*\(/,
  /express\.Router\(\)/
];
function detectSharedMutableState(files) {
  const issues = [];
  for (const file of files) {
    const mutableVars = [];
    let depth = 0;
    for (let i = 0; i < file.lines.length; i++) {
      for (const ch of file.lines[i]) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
      }
      if (depth < 0) depth = 0;
      if (depth > 0) continue;
      if (isComment2(file.lines[i])) continue;
      const m = MODULE_MUTABLE_DECL.exec(file.lines[i].trim());
      if (m) mutableVars.push({ name: m[1], line: i });
    }
    if (mutableVars.length === 0) continue;
    const functions = extractFunctionBodies(file.lines);
    for (const v of mutableVars) {
      let readInHandler = false, writeInHandler = false;
      for (const fn of functions) {
        if (!HANDLER_PATTERNS.some((p) => p.test(fn.body))) continue;
        const readRe = new RegExp(`\\b${v.name}\\b(?!\\s*=)`);
        const writeRe = new RegExp(`\\b${v.name}\\s*(?:=|\\+\\+|--|\\+=|-=|\\*=|\\.push\\(|\\.splice\\(|\\.delete\\(|\\[\\w+\\]\\s*=)`);
        if (readRe.test(fn.body)) readInHandler = true;
        if (writeRe.test(fn.body)) writeInHandler = true;
      }
      if (readInHandler && writeInHandler) {
        issues.push({
          type: "shared_mutable_state",
          severity: "warning",
          file: file.relativePath,
          line: v.line + 1,
          detail: `Module-level mutable variable '${v.name}' is read and written inside request handlers without synchronization`
        });
      }
    }
  }
  return issues;
}
var SQL_PATTERNS = [
  { regex: /\bINSERT\s+INTO\s+["'`]?(\w+)/gi, action: "INSERT" },
  { regex: /\bUPDATE\s+["'`]?(\w+)/gi, action: "UPDATE" },
  { regex: /\bDELETE\s+FROM\s+["'`]?(\w+)/gi, action: "DELETE" },
  { regex: /\bSELECT\b[^;]*?\bFROM\s+["'`]?(\w+)/gi, action: "SELECT" }
];
var TRANSACTION_PATTERNS = [
  /\bBEGIN\b/i,
  /\bCOMMIT\b/i,
  /pool\.query\s*\(\s*['"`]BEGIN/i,
  /client\.query\s*\(\s*['"`]BEGIN/i,
  /\.transaction\s*\(/,
  /\$transaction\s*\(/,
  /knex\.transaction/,
  /sequelize\.transaction/,
  /\.startSession\s*\(/,
  /withTransaction\s*\(/
];
function detectMissingTransactions(files) {
  const issues = [];
  for (const file of files) {
    for (const fn of extractFunctionBodies(file.lines)) {
      if (TRANSACTION_PATTERNS.some((p) => p.test(fn.body))) continue;
      const ops = [];
      for (let i = 0; i < fn.bodyLines.length; i++) {
        if (isComment2(fn.bodyLines[i])) continue;
        for (const { regex, action } of SQL_PATTERNS) {
          regex.lastIndex = 0;
          let m;
          while ((m = regex.exec(fn.bodyLines[i])) !== null) {
            ops.push({ action, table: m[1].toLowerCase(), line: fn.startLine + i });
          }
        }
      }
      if (ops.length < 2) continue;
      const tables = /* @__PURE__ */ new Map();
      for (const op of ops) {
        const list = tables.get(op.table) || [];
        list.push(op);
        tables.set(op.table, list);
      }
      for (const [table, tableOps] of tables) {
        const writes = tableOps.filter((o) => o.action !== "SELECT");
        const reads = tableOps.filter((o) => o.action === "SELECT");
        if (writes.length >= 2) {
          issues.push({
            type: "missing_transaction",
            severity: "error",
            file: file.relativePath,
            line: writes[0].line + 1,
            detail: `Multiple SQL writes to '${table}' in ${fn.name}() without transaction wrapper (${writes.map((w) => w.action).join(" + ")})`
          });
        } else if (reads.length > 0 && writes.length > 0) {
          issues.push({
            type: "missing_transaction",
            severity: "error",
            file: file.relativePath,
            line: reads[0].line + 1,
            detail: `SELECT + ${writes[0].action} on '${table}' in ${fn.name}() without transaction wrapper \u2014 risk of phantom reads`
          });
        }
      }
      const writeOps = ops.filter((o) => o.action !== "SELECT");
      const writeTables = new Set(writeOps.map((o) => o.table));
      if (writeTables.size >= 2) {
        const alreadyReported = issues.some(
          (iss) => iss.file === file.relativePath && iss.type === "missing_transaction" && iss.line >= fn.startLine + 1 && iss.line <= fn.endLine + 1
        );
        if (!alreadyReported) {
          issues.push({
            type: "missing_transaction",
            severity: "error",
            file: file.relativePath,
            line: writeOps[0].line + 1,
            detail: `Writes to multiple tables (${[...writeTables].join(", ")}) in ${fn.name}() without transaction wrapper \u2014 partial failure risk`
          });
        }
      }
    }
  }
  return issues;
}
var FILE_READ_RE = [/readFileSync\s*\(\s*([^,)]+)/, /readFile\s*\(\s*([^,)]+)/, /fs\.promises\.readFile\s*\(\s*([^,)]+)/];
var FILE_WRITE_RE = [/writeFileSync\s*\(\s*([^,)]+)/, /writeFile\s*\(\s*([^,)]+)/, /fs\.promises\.writeFile\s*\(\s*([^,)]+)/];
var FILE_LOCK_PATTERNS = [
  /\blockfile\b/i,
  /\bflock\b/i,
  /\.lock\b/,
  /\bmutex\b/i,
  /\bsemaphore\b/i,
  /\bproper-lockfile\b/,
  /\bacquireLock\b/,
  /\breleaseLock\b/,
  /\bwithLock\b/
];
function normPathArg(s) {
  return s.replace(/['"` ]/g, "").trim();
}
function detectFileLockAbsent(files) {
  const issues = [];
  for (const file of files) {
    for (const fn of extractFunctionBodies(file.lines)) {
      if (FILE_LOCK_PATTERNS.some((p) => p.test(fn.body))) continue;
      const reads = [];
      const writes = [];
      for (let i = 0; i < fn.bodyLines.length; i++) {
        if (isComment2(fn.bodyLines[i])) continue;
        for (const re of FILE_READ_RE) {
          const m = re.exec(fn.bodyLines[i]);
          if (m) reads.push({ path: normPathArg(m[1]), line: fn.startLine + i });
        }
        for (const re of FILE_WRITE_RE) {
          const m = re.exec(fn.bodyLines[i]);
          if (m) writes.push({ path: normPathArg(m[1]), line: fn.startLine + i });
        }
      }
      for (const r of reads) {
        if (writes.some((w) => w.path === r.path)) {
          issues.push({
            type: "file_lock_absent",
            severity: "warning",
            file: file.relativePath,
            line: r.line + 1,
            detail: `File read+write on same path (${r.path}) in ${fn.name}() without file locking \u2014 concurrent requests may clobber data`
          });
          break;
        }
      }
    }
  }
  return issues;
}
var CACHE_GET_RE = [
  /\bcache\.get\s*\(/,
  /\bredis\.get\s*\(/,
  /\bclient\.get\s*\(/,
  /\bgetCached\s*\(/,
  /\bmemcache\.get\s*\(/,
  /\blru\.get\s*\(/
];
var CACHE_SET_RE = [
  /\bcache\.set\s*\(/,
  /\bredis\.set\s*\(/,
  /\bclient\.set\s*\(/,
  /\bmemcache\.set\s*\(/,
  /\blru\.set\s*\(/
];
var EXPENSIVE_RE = [
  /\bSELECT\b/i,
  /\bpool\.query\s*\(/,
  /\bclient\.query\s*\(/,
  /\.findOne\s*\(/,
  /\.find\s*\(/,
  /\.findMany\s*\(/,
  /\bfetch\s*\(/,
  /\baxios\s*[\.(]/,
  /\bhttp\.get\s*\(/,
  /\breadFileSync\s*\(/,
  /\breadFile\s*\(/,
  /\.aggregate\s*\(/
];
var STAMPEDE_PROTECTION = [
  /\block\b/i,
  /\bmutex\b/i,
  /\bsingleflight\b/i,
  /\bcoalesce\b/i,
  /\bdedupe\b/i,
  /\bsemaphore\b/i,
  /\bpromise[_-]?cach/i,
  /\bmemoize\b/i,
  /\bthrottle\b/i,
  /\bswr\b/i,
  /\bstale-while-revalidate\b/i,
  /\bpending(?:Request|Promise|Query)\b/
];
function detectCacheStampede(files) {
  const issues = [];
  for (const file of files) {
    for (const fn of extractFunctionBodies(file.lines)) {
      if (STAMPEDE_PROTECTION.some((p) => p.test(fn.body))) continue;
      let cacheGet = -1, expensive = -1, cacheSet = -1;
      for (let i = 0; i < fn.bodyLines.length; i++) {
        if (isComment2(fn.bodyLines[i])) continue;
        const line = fn.bodyLines[i];
        if (CACHE_GET_RE.some((p) => p.test(line)) && cacheGet === -1) cacheGet = fn.startLine + i;
        if (EXPENSIVE_RE.some((p) => p.test(line)) && cacheGet !== -1 && expensive === -1) expensive = fn.startLine + i;
        if (CACHE_SET_RE.some((p) => p.test(line)) && expensive !== -1 && cacheSet === -1) cacheSet = fn.startLine + i;
      }
      if (cacheGet !== -1 && expensive !== -1 && cacheSet !== -1) {
        issues.push({
          type: "cache_stampede",
          severity: "warning",
          file: file.relativePath,
          line: cacheGet + 1,
          detail: `Cache get\u2192miss\u2192expensive query\u2192set in ${fn.name}() without stampede protection \u2014 concurrent misses all hit the expensive path`
        });
      }
    }
  }
  return issues;
}
function runContentionGate(ctx) {
  const start = Date.now();
  const issues = [];
  const baseDir = ctx.stageDir ?? ctx.config.appDir;
  const FRONTEND_EXTS = /* @__PURE__ */ new Set(["tsx", "jsx", "vue", "svelte", "html", "css", "scss", "less"]);
  const sourceFiles = [];
  for (const edit of ctx.edits) {
    if (!edit.replace) continue;
    const ext = edit.file.split(".").pop()?.toLowerCase() ?? "";
    if (FRONTEND_EXTS.has(ext)) continue;
    sourceFiles.push({
      relativePath: edit.file,
      content: edit.replace,
      lines: edit.replace.split("\n")
    });
  }
  issues.push(...detectRaceConditions(sourceFiles));
  issues.push(...detectSharedMutableState(sourceFiles));
  issues.push(...detectMissingTransactions(sourceFiles));
  issues.push(...detectFileLockAbsent(sourceFiles));
  issues.push(...detectCacheStampede(sourceFiles));
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const passed = errors.length === 0;
  let detail;
  if (issues.length === 0) {
    detail = "No contention issues detected";
  } else if (passed) {
    detail = `${warnings.length} warning(s): ${summarizeIssues(warnings)}`;
  } else {
    detail = `${errors.length} error(s), ${warnings.length} warning(s): ${summarizeIssues(errors)}`;
  }
  ctx.log(`[contention] ${detail}`);
  return {
    gate: "contention",
    passed,
    detail,
    durationMs: Date.now() - start,
    issues
  };
}
function summarizeIssues(issues) {
  const byType = /* @__PURE__ */ new Map();
  for (const i of issues) byType.set(i.type, (byType.get(i.type) ?? 0) + 1);
  const parts = [];
  for (const [type, count] of byType) parts.push(`${count}\xD7 ${type.replace(/_/g, " ")}`);
  return parts.join(", ");
}

// src/gates/observation.ts
var import_fs20 = require("fs");
var import_path20 = require("path");
function safeRead4(filePath) {
  try {
    return (0, import_fs20.existsSync)(filePath) ? (0, import_fs20.readFileSync)(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}
var CODE_EXTS3 = /* @__PURE__ */ new Set([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"]);
var SKIP_DIRS3 = /* @__PURE__ */ new Set(["node_modules", ".git", ".next", "dist", ".sovereign", ".verify"]);
function collectSourceFiles2(baseDir) {
  const files = [];
  function scan(dir, rel) {
    try {
      for (const entry of (0, import_fs20.readdirSync)(dir, { withFileTypes: true })) {
        if (SKIP_DIRS3.has(entry.name)) continue;
        const fullPath = (0, import_path20.join)(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, rel ? `${rel}/${entry.name}` : entry.name);
        } else if (CODE_EXTS3.has((0, import_path20.extname)(entry.name).toLowerCase())) {
          const relative = rel ? `${rel}/${entry.name}` : entry.name;
          const content = safeRead4(fullPath);
          if (content && content.length < 5e5) {
            files.push({ relativePath: relative, content, lines: content.split("\n") });
          }
        }
      }
    } catch {
    }
  }
  scan(baseDir, "");
  return files;
}
function isComment3(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("#");
}
var BROWSER_OBSERVE_PATTERNS = [
  // getComputedStyle forces layout recalculation
  {
    regex: /getComputedStyle\s*\(/,
    effect: "getComputedStyle forces synchronous layout recalculation \u2014 changes rendering state"
  },
  // getBoundingClientRect triggers reflow
  {
    regex: /getBoundingClientRect\s*\(/,
    effect: "getBoundingClientRect triggers reflow \u2014 changes layout engine state"
  },
  // scrollIntoView triggers lazy-load and intersection observers
  {
    regex: /scrollIntoView\s*\(/,
    effect: "scrollIntoView triggers IntersectionObserver callbacks \u2014 may lazy-load content"
  },
  // offsetHeight/Width forces synchronous layout
  {
    regex: /\b(?:offsetHeight|offsetWidth|offsetTop|offsetLeft|clientHeight|clientWidth)\b/,
    effect: "Reading offset/client dimensions forces synchronous layout \u2014 changes rendering state"
  },
  // Screenshot capture forces full repaint
  {
    regex: /screenshot\s*\(|captureScreenshot|toDataURL\s*\(/,
    effect: "Screenshot capture forces full repaint cycle \u2014 changes GPU compositing state"
  },
  // window.getSelection forces layout for text measurement
  {
    regex: /getSelection\s*\(/,
    effect: "getSelection forces layout for text measurement \u2014 changes rendering pipeline state"
  },
  // IntersectionObserver observe triggers entry computation
  {
    regex: /IntersectionObserver[^}]*\.observe\s*\(/,
    effect: "Observing elements triggers initial entry computation \u2014 side effect on observe"
  },
  // MutationObserver with childList creates event overhead
  {
    regex: /MutationObserver[^}]*childList\s*:\s*true/,
    effect: "MutationObserver with childList creates event processing overhead per DOM change"
  },
  // ResizeObserver triggers on observation start
  {
    regex: /ResizeObserver[^}]*\.observe\s*\(/,
    effect: "ResizeObserver fires initial callback on observe \u2014 observation triggers measurement"
  }
];
var BROWSER_AWARE_PATTERNS = [
  /requestAnimationFrame\s*\(/,
  /requestIdleCallback\s*\(/,
  /will-change/,
  /contain:\s*layout/,
  /contain:\s*strict/,
  /transform:\s*translateZ/,
  /backface-visibility/,
  /\bdocument\.hidden\b/,
  /visibilitychange/
];
function detectBrowserObservation(files) {
  const effects = [];
  for (const file of files) {
    if (file.relativePath.includes("server") && !file.relativePath.includes("client")) continue;
    const isAware = BROWSER_AWARE_PATTERNS.some((p) => p.test(file.content));
    if (isAware) continue;
    for (let i = 0; i < file.lines.length; i++) {
      if (isComment3(file.lines[i])) continue;
      for (const { regex, effect } of BROWSER_OBSERVE_PATTERNS) {
        if (regex.test(file.lines[i])) {
          effects.push({
            domain: "browser_observation",
            severity: "warning",
            file: file.relativePath,
            line: i + 1,
            detail: `Browser observation side effect at line ${i + 1}: ${effect}`,
            assumption: "DOM measurement is side-effect-free",
            reality: effect
          });
          break;
        }
      }
    }
  }
  return effects;
}
var DB_OBSERVE_PATTERNS = [
  // pg_stat_statements tracks every query including observation queries
  {
    regex: /pg_stat_statements/i,
    effect: "pg_stat_statements tracks all queries \u2014 observation queries add tracking rows"
  },
  // EXPLAIN ANALYZE updates table statistics
  {
    regex: /EXPLAIN\s+ANALYZE/i,
    effect: "EXPLAIN ANALYZE actually executes the query and updates table statistics"
  },
  // information_schema queries update pg_stat_user_tables
  {
    regex: /information_schema\.\w+/i,
    effect: "information_schema queries update internal catalog statistics (pg_stat_user_tables)"
  },
  // SELECT with FOR UPDATE acquires row locks
  {
    regex: /SELECT\s+[^;]*FOR\s+UPDATE/i,
    effect: "SELECT FOR UPDATE acquires row-level locks \u2014 observation blocks concurrent writes"
  },
  // SELECT with FOR SHARE acquires shared locks
  {
    regex: /SELECT\s+[^;]*FOR\s+SHARE/i,
    effect: "SELECT FOR SHARE acquires shared locks \u2014 observation contends with exclusive locks"
  },
  // Trigger-based audit: any SELECT on audited table fires trigger
  {
    regex: /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+\w+\s+(?:BEFORE|AFTER)\s+(?:SELECT|INSERT|UPDATE|DELETE)/i,
    effect: "Trigger fires on data access \u2014 observation itself generates audit/mutation events"
  },
  // pg_stat_activity — querying it is itself visible in pg_stat_activity
  {
    regex: /pg_stat_activity/i,
    effect: "Querying pg_stat_activity creates a new entry \u2014 observing connections adds a connection"
  },
  // Connection pool metrics — each probe consumes a connection
  {
    regex: /(?:pool_size|max_connections|idle_connections)/i,
    effect: "Checking connection count requires a connection \u2014 observer occupies a slot"
  },
  // Advisory locks — checking lock state may acquire transient locks
  {
    regex: /pg_advisory_lock|pg_try_advisory_lock/i,
    effect: "Advisory lock queries may interact with lock state \u2014 observation may serialize"
  }
];
var DB_AWARE_PATTERNS = [
  /-- observation side effect/i,
  /-- observer effect/i,
  /SET\s+statement_timeout/i,
  /idle_in_transaction_session_timeout/i,
  /-- read-only transaction/i,
  /SET\s+TRANSACTION\s+READ\s+ONLY/i,
  /pg_stat_reset/i
];
function detectDatabaseObservation(files) {
  const effects = [];
  for (const file of files) {
    const isAware = DB_AWARE_PATTERNS.some((p) => p.test(file.content));
    if (isAware) continue;
    for (let i = 0; i < file.lines.length; i++) {
      if (isComment3(file.lines[i])) continue;
      for (const { regex, effect } of DB_OBSERVE_PATTERNS) {
        if (regex.test(file.lines[i])) {
          effects.push({
            domain: "database_observation",
            severity: "warning",
            file: file.relativePath,
            line: i + 1,
            detail: `Database observation side effect at line ${i + 1}: ${effect}`,
            assumption: "Database read is side-effect-free",
            reality: effect
          });
          break;
        }
      }
    }
  }
  return effects;
}
var CLI_OBSERVE_PATTERNS = [
  // Healthcheck with restart policy — failed probe triggers restart
  {
    regex: /healthcheck.*restart|restart.*healthcheck/i,
    effect: "Healthcheck failure triggers container restart \u2014 observation can cause mutation"
  },
  // docker stats / docker ps overhead
  {
    regex: /docker\s+(?:stats|top|inspect)\b/i,
    effect: "docker stats/top/inspect adds cgroup query overhead \u2014 changes container CPU metrics"
  },
  // wget/curl to health endpoint — creates HTTP request that generates logs
  {
    regex: /(?:wget|curl)\s+.*(?:\/health|\/status|\/ready|\/live)/i,
    effect: "Health probe creates HTTP request \u2192 access log entry \u2014 observation inflates logs"
  },
  // Writing probe results to temp files
  {
    regex: /(?:wget|curl)\s+.*-[oO]\s+(?:\/tmp|\.\/tmp)/i,
    effect: "Probe writes result to temp file \u2014 observation consumes disk space"
  },
  // systemctl status creates audit log entries
  {
    regex: /systemctl\s+(?:status|is-active|show)\b/i,
    effect: "systemctl status creates D-Bus message + journal entry \u2014 observation inflates journal"
  },
  // journalctl reads may trigger log rotation
  {
    regex: /journalctl\b.*--rotate|--vacuum/i,
    effect: "journalctl with rotation flags changes log state \u2014 observation triggers cleanup"
  },
  // df/du commands — disk check itself uses some I/O
  {
    regex: /\bdf\s+-[hHk]|\bdu\s+-[shHk]/,
    effect: "Disk usage check traverses filesystem \u2014 changes atime and generates I/O load"
  },
  // Process listing adds to audit trail
  {
    regex: /\bps\s+aux|\btop\s+-b/,
    effect: "Process listing adds to audit trail on systems with auditing enabled"
  },
  // Log read-and-clear pattern (consume on read)
  {
    regex: /readFileSync[^;]*log.*(?:truncate|unlink|writeFileSync.*'')|appendFileSync[^;]*healthcheck/i,
    effect: "Log read-and-clear pattern \u2014 observation destroys the measurement data"
  },
  // Healthcheck with --interval creates periodic overhead
  {
    regex: /HEALTHCHECK\s+--interval/i,
    effect: "Periodic healthcheck interval creates continuous observation overhead \u2014 CPU + network"
  }
];
var CLI_AWARE_PATTERNS = [
  /logging:\s*{[^}]*max/i,
  /log.*rotation/i,
  /--quiet\b/,
  /--silent\b/,
  /-q\b/,
  /\/dev\/null/,
  /> \/dev\/null/,
  /no.?op\b|noop\b/i
];
function detectCliObservation(files) {
  const effects = [];
  for (const file of files) {
    const isAware = CLI_AWARE_PATTERNS.some((p) => p.test(file.content));
    if (isAware) continue;
    for (let i = 0; i < file.lines.length; i++) {
      if (isComment3(file.lines[i])) continue;
      for (const { regex, effect } of CLI_OBSERVE_PATTERNS) {
        if (regex.test(file.lines[i])) {
          effects.push({
            domain: "cli_observation",
            severity: "warning",
            file: file.relativePath,
            line: i + 1,
            detail: `CLI observation side effect at line ${i + 1}: ${effect}`,
            assumption: "Diagnostic command is side-effect-free",
            reality: effect
          });
          break;
        }
      }
    }
  }
  return effects;
}
var CONFIG_OBSERVE_PATTERNS = [
  // fs.watch / chokidar on config files — read triggers watcher
  {
    regex: /(?:fs\.watch|chokidar\.watch|watchFile)\s*\([^)]*(?:config|\.env|settings)/i,
    effect: "File watcher on config \u2014 reading/touching config file triggers hot reload"
  },
  // Lazy initialization on first env var read
  {
    regex: /process\.env\.\w+[^;]*\|\||process\.env\.\w+[^;]*\?\?/,
    effect: "Env var read with fallback suggests lazy initialization \u2014 first read may trigger setup"
  },
  // dotenv.config() — loading env triggers initialization
  {
    regex: /dotenv\.config\s*\(|require\s*\(\s*['"]dotenv['"]\s*\)\.config/,
    effect: "dotenv.config() parses and mutates process.env \u2014 observation changes env state"
  },
  // Secret access audit logging
  {
    regex: /(?:SECRET|API_KEY|TOKEN|PASSWORD|PRIVATE_KEY)\b[^;]*(?:log|audit|track|record)/i,
    effect: "Secret access with logging \u2014 observation creates audit trail entry"
  },
  // Config version check — may trigger version bump or sync
  {
    regex: /configVersion|config_version|schema_version/i,
    effect: "Config version check may trigger version synchronization or migration"
  },
  // Feature flag read with analytics
  {
    regex: /(?:feature|flag|toggle)\b[^;]*(?:analytics|telemetry|track|emit|send)/i,
    effect: "Feature flag read triggers analytics event \u2014 observation changes telemetry state"
  },
  // Hot module replacement — import triggers code evaluation
  {
    regex: /module\.hot\.accept|import\.meta\.hot/,
    effect: "HMR observation triggers module re-evaluation \u2014 changes runtime code state"
  },
  // JSON.parse of config file — parse errors may trigger error handlers
  {
    regex: /JSON\.parse\s*\([^)]*(?:readFileSync|readFile)[^)]*(?:config|settings|\.env)/i,
    effect: "Config file parse \u2014 malformed config triggers error handler side effects"
  },
  // Auto-reload / auto-refresh on config change
  {
    regex: /(?:auto[_-]?reload|hot[_-]?reload|live[_-]?reload)\b/i,
    effect: "Auto-reload pattern \u2014 config observation triggers application restart"
  }
];
var CONFIG_AWARE_PATTERNS = [
  /-- no reload/i,
  /skipReload/i,
  /noWatch/i,
  /readOnly\s*:\s*true/i,
  /immutable/i,
  /\.freeze\s*\(/,
  /Object\.freeze/,
  /cache.*config|config.*cache/i
];
function detectConfigObservation(files) {
  const effects = [];
  for (const file of files) {
    const isAware = CONFIG_AWARE_PATTERNS.some((p) => p.test(file.content));
    if (isAware) continue;
    for (let i = 0; i < file.lines.length; i++) {
      if (isComment3(file.lines[i])) continue;
      for (const { regex, effect } of CONFIG_OBSERVE_PATTERNS) {
        if (regex.test(file.lines[i])) {
          effects.push({
            domain: "config_observation",
            severity: "warning",
            file: file.relativePath,
            line: i + 1,
            detail: `Config observation side effect at line ${i + 1}: ${effect}`,
            assumption: "Config read is side-effect-free",
            reality: effect
          });
          break;
        }
      }
    }
  }
  return effects;
}
var CROSS_SOURCE_PATTERNS = [
  // DB: pg_stat_statements in init.sql but not referenced in server.js
  {
    domain: "database_observation",
    indicator: /pg_stat_statements/i,
    expectedIn: ["server.js", "server.ts", "app.js", "app.ts", "index.js", "index.ts"],
    description: "pg_stat_statements extension enabled but application code has no awareness"
  },
  // DB: audit_trail table in init.sql but not referenced in server
  {
    domain: "database_observation",
    indicator: /audit_trail|audit_log/i,
    expectedIn: ["server.js", "server.ts", "app.js", "app.ts"],
    description: "Audit trail table exists but application code has no audit awareness"
  },
  // CLI: healthcheck interval in docker-compose but no log awareness
  {
    domain: "cli_observation",
    indicator: /interval:\s*\d+s/i,
    expectedIn: ["server.js", "server.ts", "app.js", "app.ts"],
    description: "Healthcheck interval configured but application has no interval/rate awareness"
  },
  // Config: file watcher in config but no hot-reload handling
  {
    domain: "config_observation",
    indicator: /fs\.watch|chokidar|watchFile/i,
    expectedIn: ["config.json", "config.js", "config.ts", ".env"],
    description: "File watcher active but config files have no reload handling awareness"
  }
];
function detectCrossSourceMismatch(baseDir, edits) {
  const effects = [];
  const fileContents = /* @__PURE__ */ new Map();
  for (const edit of edits) {
    if (edit.replace) {
      const existing = fileContents.get(edit.file) ?? "";
      fileContents.set(edit.file, existing + "\n" + edit.replace);
    }
  }
  const keyFiles = [
    "server.js",
    "server.ts",
    "app.js",
    "app.ts",
    "index.js",
    "index.ts",
    "init.sql",
    "schema.sql",
    "config.json",
    ".env",
    "docker-compose.yml",
    "docker-compose.yaml",
    "Dockerfile"
  ];
  for (const f of keyFiles) {
    if (!fileContents.has(f)) {
      const content = safeRead4((0, import_path20.join)(baseDir, f));
      if (content) fileContents.set(f, content);
    }
  }
  for (const { domain, indicator, expectedIn, description } of CROSS_SOURCE_PATTERNS) {
    for (const [file, content] of fileContents) {
      if (!indicator.test(content)) continue;
      for (const expected of expectedIn) {
        if (expected === file) continue;
        const expectedContent = fileContents.get(expected);
        if (expectedContent && indicator.test(expectedContent)) continue;
        if (expectedContent !== void 0) {
          effects.push({
            domain,
            severity: "warning",
            file,
            line: 0,
            detail: `Cross-source observer effect: ${description} (declared in ${file}, missing in ${expected})`,
            assumption: `${expected} is aware of observation side effects from ${file}`,
            reality: `${expected} has no reference to the observation pattern`
          });
          break;
        }
      }
    }
  }
  return effects;
}
function runObservationGate(ctx) {
  const start = Date.now();
  const effects = [];
  const baseDir = ctx.stageDir ?? ctx.config.appDir;
  const sourceFiles = [];
  for (const edit of ctx.edits) {
    if (!edit.replace) continue;
    sourceFiles.push({
      relativePath: edit.file,
      content: edit.replace,
      lines: edit.replace.split("\n")
    });
  }
  const allFiles = collectSourceFiles2(baseDir);
  effects.push(...detectBrowserObservation(sourceFiles));
  effects.push(...detectDatabaseObservation(sourceFiles));
  effects.push(...detectCliObservation(sourceFiles));
  effects.push(...detectConfigObservation(sourceFiles));
  effects.push(...detectCrossSourceMismatch(baseDir, ctx.edits));
  effects.push(...detectBrowserObservation(allFiles));
  effects.push(...detectDatabaseObservation(allFiles));
  effects.push(...detectCliObservation(allFiles));
  effects.push(...detectConfigObservation(allFiles));
  const seen = /* @__PURE__ */ new Set();
  const deduped = effects.filter((e) => {
    const key = `${e.file}:${e.line}:${e.domain}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const byDomain = /* @__PURE__ */ new Map();
  for (const e of deduped) byDomain.set(e.domain, (byDomain.get(e.domain) ?? 0) + 1);
  let detail;
  if (deduped.length === 0) {
    detail = "No observer effects detected \u2014 verification is side-effect-free";
  } else {
    const parts = [];
    for (const [domain, count] of byDomain) {
      parts.push(`${count}\xD7 ${domain.replace(/_/g, " ")}`);
    }
    detail = `${deduped.length} observer effect(s): ${parts.join(", ")}`;
  }
  ctx.log(`[observation] ${detail}`);
  return {
    gate: "observation",
    passed: true,
    detail,
    durationMs: Date.now() - start,
    effects: deduped
  };
}
function isObservationRelevant(edits) {
  return edits.length > 0;
}

// src/runners/docker-runner.ts
var import_child_process3 = require("child_process");
var import_path21 = require("path");
var import_fs21 = require("fs");
var DEFAULT_PORT = 3e3;
var DEFAULT_HEALTH_PATH = "/";
var DEFAULT_STARTUP_TIMEOUT = 6e4;
var DEFAULT_BUILD_TIMEOUT = 12e4;
var LocalDockerRunner = class {
  appDir;
  composefile;
  service;
  internalPort;
  healthPath;
  startupTimeout;
  buildTimeout;
  projectName;
  hostPort = 0;
  running = false;
  constructor(config) {
    this.appDir = config.appDir;
    this.composefile = config.docker?.composefile ?? "docker-compose.yml";
    this.service = config.docker?.service ?? "app";
    this.internalPort = config.docker?.port ?? DEFAULT_PORT;
    this.healthPath = config.docker?.healthPath ?? DEFAULT_HEALTH_PATH;
    this.startupTimeout = config.docker?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT;
    this.buildTimeout = config.docker?.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT;
    this.projectName = `verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.hostPort = 13e3 + Math.floor(Math.random() * 1e3);
  }
  async build(opts) {
    const args = [
      "compose",
      "-f",
      this.composefile,
      "-p",
      this.projectName,
      "build",
      this.service
    ];
    if (opts?.noCache) args.push("--no-cache");
    return this.run("docker", args, {
      timeoutMs: opts?.timeoutMs ?? this.buildTimeout,
      cwd: this.appDir
    });
  }
  async start(opts) {
    const timeout = opts?.timeoutMs ?? this.startupTimeout;
    const result = await this.run("docker", [
      "compose",
      "-f",
      this.composefile,
      "-p",
      this.projectName,
      "up",
      "-d",
      "--build",
      this.service
    ], {
      timeoutMs: this.buildTimeout + timeout,
      cwd: this.appDir,
      env: {
        ...process.env,
        // Override port mapping: host:container
        VERIFY_HOST_PORT: String(this.hostPort)
      }
    });
    if (result.exitCode !== 0) return result;
    const deadline = Date.now() + timeout;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        healthy = await this.isHealthy();
        if (healthy) break;
      } catch {
      }
      await new Promise((r) => setTimeout(r, 1e3));
    }
    if (!healthy) {
      const logs = await this.run("docker", [
        "compose",
        "-f",
        this.composefile,
        "-p",
        this.projectName,
        "logs",
        "--tail",
        "50",
        this.service
      ], { cwd: this.appDir });
      return {
        stdout: "",
        stderr: `Container failed to become healthy within ${timeout}ms.

Container logs:
${logs.stdout}
${logs.stderr}`,
        exitCode: 1
      };
    }
    this.running = true;
    return { stdout: `Container started on port ${this.hostPort}`, stderr: "", exitCode: 0 };
  }
  async stop() {
    if (!this.running) return;
    try {
      await this.run("docker", [
        "compose",
        "-f",
        this.composefile,
        "-p",
        this.projectName,
        "down",
        "-v",
        "--remove-orphans"
      ], {
        cwd: this.appDir,
        timeoutMs: 3e4
      });
    } catch {
    }
    this.running = false;
  }
  async exec(command, opts) {
    const containerName = this.getContainerName();
    return this.run("docker", [
      "exec",
      containerName,
      "sh",
      "-c",
      command
    ], { timeoutMs: opts?.timeoutMs ?? 1e4 });
  }
  getAppUrl() {
    return `http://localhost:${this.hostPort}`;
  }
  getContainerName() {
    return `${this.projectName}-${this.service}-1`;
  }
  async isHealthy(path) {
    const url = `${this.getAppUrl()}${path ?? this.healthPath}`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3e3);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      return resp.status < 500;
    } catch {
      return false;
    }
  }
  getHostPort() {
    return this.hostPort;
  }
  isRunning() {
    return this.running;
  }
  // -------------------------------------------------------------------------
  // Internal: shell command execution
  // -------------------------------------------------------------------------
  run(cmd, args, opts) {
    return new Promise((resolve2) => {
      const cwd = opts?.cwd ?? this.appDir;
      const child = (0, import_child_process3.spawn)(cmd, args, {
        cwd,
        env: opts?.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32"
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      const timer = opts?.timeoutMs ? setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5e3);
      }, opts.timeoutMs) : void 0;
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve2({ stdout, stderr, exitCode: code ?? 1 });
      });
      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        resolve2({ stdout, stderr: err.message, exitCode: 1 });
      });
    });
  }
};
async function isDockerAvailable() {
  return new Promise((resolve2) => {
    const child = (0, import_child_process3.spawn)("docker", ["info"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32"
    });
    child.on("close", (code) => resolve2(code === 0));
    child.on("error", () => resolve2(false));
  });
}
var _dockerComposeCache = /* @__PURE__ */ new Map();
function hasDockerCompose(appDir, composefile) {
  const cacheKey = `${appDir}:${composefile ?? ""}`;
  const cached = _dockerComposeCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < 5e3) return cached.result;
  const candidates = composefile ? [composefile] : ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
  const result = candidates.some((f) => (0, import_fs21.existsSync)((0, import_path21.join)(appDir, f)));
  _dockerComposeCache.set(cacheKey, { result, cachedAt: Date.now() });
  return result;
}

// src/verify.ts
async function verify(edits, predicates, config) {
  const totalStart = Date.now();
  const gates = [];
  const logs = [];
  const log = (msg) => {
    logs.push(`[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}`);
  };
  const stateDir = config.stateDir ?? (0, import_path22.join)(config.appDir, ".verify");
  (0, import_fs22.mkdirSync)(stateDir, { recursive: true });
  const store = new ConstraintStore(stateDir);
  if (config.constraints && config.constraints.length > 0) {
    for (const c of config.constraints) {
      const safe = {
        appliesTo: [],
        surface: { files: [], intents: [] },
        requires: {},
        ...c
      };
      store.data.constraints.push(safe);
    }
    log(`[K5] Pre-seeded ${config.constraints.length} constraint(s) from config`);
  }
  const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const gateConfig = config.gates ?? {};
  let runner;
  let stageDir;
  let browserScreenshots;
  try {
    log("[grounding] Scanning app directory...");
    const grounding = groundInReality(config.appDir);
    log(`[grounding] Found ${grounding.routes.length} routes, ${grounding.routeCSSMap.size} route CSS maps`);
    const hasCompose = hasDockerCompose(config.appDir, config.docker?.composefile);
    const dockerPlausible = gateConfig.staging !== false && hasCompose;
    const groundedPredicates = validateAgainstGrounding(predicates, grounding, {
      appDir: config.appDir,
      dockerAvailable: dockerPlausible,
      edits,
      appUrl: config.appUrl
    });
    const fingerprints = groundedPredicates.map((p) => predicateFingerprint(p));
    const ctx = {
      config,
      edits,
      predicates: groundedPredicates,
      grounding,
      log
    };
    if (gateConfig.grounding !== false) {
      const groundingStart = Date.now();
      const missed = groundedPredicates.filter((p) => p.groundingMiss === true);
      if (missed.length > 0) {
        const detail = missed.map(
          (p) => p.groundingReason ?? `${p.type} predicate references "${p.selector}" which does not exist in the app`
        ).join("; ");
        log(`[grounding] FAILED: ${detail}`);
        const groundingGate = {
          gate: "grounding",
          passed: false,
          detail,
          durationMs: Date.now() - groundingStart
        };
        gates.push(groundingGate);
        return buildResult({
          gates,
          config,
          store,
          sessionId,
          totalStart,
          logs,
          failedGate: "grounding",
          error: detail,
          edits,
          predicates: groundedPredicates
        });
      }
      gates.push({
        gate: "grounding",
        passed: true,
        detail: `All ${groundedPredicates.length} predicates grounded in reality`,
        durationMs: Date.now() - groundingStart
      });
      log("[grounding] All predicates grounded");
    }
    if (gateConfig.syntax !== false) {
      log("[F9] Running syntax validation...");
      stageDir = (0, import_path22.join)((0, import_os.tmpdir)(), `verify-stage-${sessionId}`);
      (0, import_fs22.mkdirSync)(stageDir, { recursive: true });
      copyAppDir(config.appDir, stageDir);
      ctx.stageDir = stageDir;
      const syntaxResult = runSyntaxGate(ctx);
      gates.push(syntaxResult);
      if (!syntaxResult.passed) {
        log(`[F9] FAILED: ${syntaxResult.detail}`);
        return buildResult({
          gates,
          config,
          store,
          sessionId,
          totalStart,
          logs,
          failedGate: "F9",
          error: syntaxResult.detail,
          edits,
          predicates: groundedPredicates
        });
      }
      log("[F9] Applying edits to staging workspace...");
      const editResults = applyEdits(edits, stageDir);
      const failed = editResults.filter((r) => !r.applied);
      if (failed.length > 0) {
        const detail = `Edit application failed: ${failed.map((f) => `${f.file}: ${f.reason}`).join("; ")}`;
        log(`[F9] ${detail}`);
        gates.push({ gate: "F9_apply", passed: false, detail, durationMs: Date.now() - totalStart });
        return buildResult({
          gates,
          config,
          store,
          sessionId,
          totalStart,
          logs,
          failedGate: "F9",
          error: detail,
          edits,
          predicates: groundedPredicates
        });
      }
    }
    if (gateConfig.constraints !== false) {
      log("[K5] Checking learned constraints...");
      const constraintResult = runConstraintGate(ctx, store, config.overrideConstraints);
      gates.push(constraintResult);
      if (!constraintResult.passed) {
        log(`[K5] BLOCKED: ${constraintResult.detail}`);
        return buildResult({
          gates,
          config,
          store,
          sessionId,
          totalStart,
          logs,
          failedGate: "K5",
          error: constraintResult.detail,
          edits,
          predicates: groundedPredicates,
          violation: constraintResult.violation
        });
      }
    }
    if (gateConfig.containment !== false) {
      log("[G5] Checking edit containment...");
      const containmentResult = runContainmentGate(ctx);
      gates.push(containmentResult);
    }
    {
      const hasHalPreds = groundedPredicates.some((p) => p.type === "hallucination");
      if (hasHalPreds) {
        log("[hallucination] Checking agent claims against ground truth...");
        const halResult = runHallucinationGate(ctx);
        gates.push(halResult);
        if (!halResult.passed) {
          log(`[hallucination] FAILED: ${halResult.detail}`);
          return buildResult({
            gates,
            config,
            store,
            sessionId,
            totalStart,
            logs,
            failedGate: "hallucination",
            error: halResult.detail,
            edits,
            predicates: groundedPredicates
          });
        }
      }
    }
    if (gateConfig.access !== false) {
      log("[access] Checking privilege boundaries...");
      const accessResult = runAccessGate(ctx);
      gates.push(accessResult);
      if (!accessResult.passed) {
        log(`[access] FAILED: ${accessResult.detail}`);
        return buildResult({
          gates,
          config,
          store,
          sessionId,
          totalStart,
          logs,
          failedGate: "access",
          error: accessResult.detail,
          edits,
          predicates: groundedPredicates
        });
      }
    }
    if (gateConfig.temporal !== false) {
      log("[temporal] Checking for temporal drift...");
      const temporalResult = runTemporalGate(ctx);
      gates.push(temporalResult);
      if (!temporalResult.passed) {
        log(`[temporal] FAILED: ${temporalResult.detail}`);
        return buildResult({
          gates,
          config,
          store,
          sessionId,
          totalStart,
          logs,
          failedGate: "temporal",
          error: temporalResult.detail,
          edits,
          predicates: groundedPredicates
        });
      }
    }
    if (gateConfig.propagation !== false) {
      log("[propagation] Checking for propagation breaks...");
      const propagationResult = runPropagationGate(ctx);
      gates.push(propagationResult);
      if (!propagationResult.passed) {
        log(`[propagation] FAILED: ${propagationResult.detail}`);
        return buildResult({
          gates,
          config,
          store,
          sessionId,
          totalStart,
          logs,
          failedGate: "propagation",
          error: propagationResult.detail,
          edits,
          predicates: groundedPredicates
        });
      }
    }
    if (gateConfig.state !== false) {
      log("[state] Checking state assumptions...");
      const stateResult = runStateGate(ctx);
      gates.push(stateResult);
      if (!stateResult.passed) {
        log(`[state] FAILED: ${stateResult.detail}`);
        return buildResult({
          gates,
          config,
          store,
          sessionId,
          totalStart,
          logs,
          failedGate: "state",
          error: stateResult.detail,
          edits,
          predicates: groundedPredicates
        });
      }
    }
    if (gateConfig.capacity !== false) {
      log("[capacity] Checking for capacity issues...");
      const capacityResult = runCapacityGate(ctx);
      gates.push(capacityResult);
      if (!capacityResult.passed) {
        log(`[capacity] FAILED: ${capacityResult.detail}`);
        return buildResult({
          gates,
          config,
          store,
          sessionId,
          totalStart,
          logs,
          failedGate: "capacity",
          error: capacityResult.detail,
          edits,
          predicates: groundedPredicates
        });
      }
    }
    if (gateConfig.contention !== false) {
      log("[contention] Checking for contention issues...");
      const contentionResult = runContentionGate(ctx);
      gates.push(contentionResult);
      if (!contentionResult.passed) {
        log(`[contention] FAILED: ${contentionResult.detail}`);
        return buildResult({
          gates,
          config,
          store,
          sessionId,
          totalStart,
          logs,
          failedGate: "contention",
          error: contentionResult.detail,
          edits,
          predicates: groundedPredicates
        });
      }
    }
    if (isObservationRelevant(edits)) {
      log("[observation] Checking for observer effects...");
      const observationResult = runObservationGate(ctx);
      gates.push(observationResult);
      if (observationResult.effects?.length > 0) {
        log(`[observation] ${observationResult.effects.length} observer effect(s) detected (advisory)`);
      }
    }
    {
      const hasFilesystemPreds = groundedPredicates.some(
        (p) => p.type === "filesystem_exists" || p.type === "filesystem_absent" || p.type === "filesystem_unchanged" || p.type === "filesystem_count"
      );
      if (hasFilesystemPreds) {
        log("[filesystem] Running filesystem predicate validation...");
        const fsResult = runFilesystemGate(ctx);
        gates.push(fsResult);
        if (!fsResult.passed) {
          log(`[filesystem] FAILED: ${fsResult.detail}`);
          return buildResult({
            gates,
            config,
            store,
            sessionId,
            totalStart,
            logs,
            failedGate: "filesystem",
            error: fsResult.detail,
            edits,
            predicates: groundedPredicates
          });
        }
      }
    }
    {
      const hasInfraPreds = groundedPredicates.some(
        (p) => p.type === "infra_resource" || p.type === "infra_attribute" || p.type === "infra_manifest"
      );
      if (hasInfraPreds) {
        log("[infrastructure] Running infrastructure predicate validation...");
        const infraResult = runInfrastructureGate(ctx);
        gates.push(infraResult);
        if (!infraResult.passed) {
          log(`[infrastructure] FAILED: ${infraResult.detail}`);
          return buildResult({
            gates,
            config,
            store,
            sessionId,
            totalStart,
            logs,
            failedGate: "infrastructure",
            error: infraResult.detail,
            edits,
            predicates: groundedPredicates
          });
        }
      }
    }
    {
      const hasSerPreds = groundedPredicates.some((p) => p.type === "serialization");
      if (hasSerPreds) {
        log("[serialization] Running serialization validation...");
        const serResult = runSerializationGate(ctx);
        gates.push(serResult);
        if (!serResult.passed) {
          log(`[serialization] FAILED: ${serResult.detail}`);
          return buildResult({
            gates,
            config,
            store,
            sessionId,
            totalStart,
            logs,
            failedGate: "serialization",
            error: serResult.detail,
            edits,
            predicates: groundedPredicates
          });
        }
      }
    }
    {
      const hasConfigPreds = groundedPredicates.some((p) => p.type === "config");
      if (hasConfigPreds) {
        log("[config] Running configuration validation...");
        const configResult = runConfigGate(ctx);
        gates.push(configResult);
        if (!configResult.passed) {
          log(`[config] FAILED: ${configResult.detail}`);
          return buildResult({
            gates,
            config,
            store,
            sessionId,
            totalStart,
            logs,
            failedGate: "config",
            error: configResult.detail,
            edits,
            predicates: groundedPredicates
          });
        }
      }
    }
    {
      const hasSecPreds = groundedPredicates.some((p) => p.type === "security");
      if (hasSecPreds) {
        log("[security] Running security scan...");
        const secResult = runSecurityGate(ctx);
        gates.push(secResult);
        if (!secResult.passed) {
          log(`[security] FAILED: ${secResult.detail}`);
          return buildResult({
            gates,
            config,
            store,
            sessionId,
            totalStart,
            logs,
            failedGate: "security",
            error: secResult.detail,
            edits,
            predicates: groundedPredicates
          });
        }
      }
    }
    {
      const hasA11yPreds = groundedPredicates.some((p) => p.type === "a11y");
      if (hasA11yPreds) {
        log("[a11y] Running accessibility checks...");
        const a11yResult = runA11yGate(ctx);
        gates.push(a11yResult);
        if (!a11yResult.passed) {
          log(`[a11y] FAILED: ${a11yResult.detail}`);
          return buildResult({
            gates,
            config,
            store,
            sessionId,
            totalStart,
            logs,
            failedGate: "a11y",
            error: a11yResult.detail,
            edits,
            predicates: groundedPredicates
          });
        }
      }
    }
    {
      const hasPerfPreds = groundedPredicates.some((p) => p.type === "performance");
      if (hasPerfPreds) {
        log("[performance] Running performance analysis...");
        const perfResult = runPerformanceGate(ctx);
        gates.push(perfResult);
        if (!perfResult.passed) {
          log(`[performance] FAILED: ${perfResult.detail}`);
          return buildResult({
            gates,
            config,
            store,
            sessionId,
            totalStart,
            logs,
            failedGate: "performance",
            error: perfResult.detail,
            edits,
            predicates: groundedPredicates
          });
        }
      }
    }
    const dockerAvailable = await isDockerAvailable();
    const hasStagingCompose = hasDockerCompose(stageDir ?? config.appDir, config.docker?.composefile);
    const shouldStage = gateConfig.staging !== false && dockerAvailable && hasStagingCompose && !config.appUrl;
    if (shouldStage) {
      log("[staging] Starting Docker staging...");
      const stagingConfig = stageDir ? { ...config, appDir: stageDir } : config;
      runner = new LocalDockerRunner(stagingConfig);
      ctx.runner = runner;
      const stagingResult = await runStagingGate(ctx, runner);
      gates.push(stagingResult);
      if (!stagingResult.passed) {
        log(`[staging] FAILED: ${stagingResult.detail}`);
        return buildResult({
          gates,
          config,
          store,
          sessionId,
          totalStart,
          logs,
          failedGate: "staging",
          error: stagingResult.detail,
          edits,
          predicates: groundedPredicates
        });
      }
      ctx.appUrl = runner.getAppUrl();
      if (gateConfig.browser !== false) {
        log("[browser] Running Playwright validation...");
        const browserResult = await runBrowserGate(ctx);
        gates.push(browserResult);
        if (browserResult.screenshots) {
          browserScreenshots = browserResult.screenshots;
          log(`[browser] ${Object.keys(browserScreenshots).length} screenshot(s) captured for vision gate`);
        }
        if (!browserResult.passed) {
          log(`[browser] FAILED: ${browserResult.detail}`);
          return buildResult({
            gates,
            config,
            store,
            sessionId,
            totalStart,
            logs,
            failedGate: "browser",
            error: browserResult.detail,
            edits,
            predicates: groundedPredicates
          });
        }
      }
      if (gateConfig.http !== false) {
        const httpPredicates = groundedPredicates.filter(
          (p) => p.type === "http" || p.type === "http_sequence"
        );
        if (httpPredicates.length > 0) {
          log("[http] Running HTTP predicate validation...");
          const httpResult = await runHttpGate(ctx);
          gates.push(httpResult);
          if (!httpResult.passed) {
            log(`[http] FAILED: ${httpResult.detail}`);
            return buildResult({
              gates,
              config,
              store,
              sessionId,
              totalStart,
              logs,
              failedGate: "http",
              error: httpResult.detail,
              edits,
              predicates: groundedPredicates
            });
          }
        }
      }
      const invariants = config.invariants ?? loadInvariantsFile(config.appDir);
      if (gateConfig.invariants !== false && invariants.length > 0) {
        log("[invariants] Running system health checks...");
        const invResult = await runInvariantsGate(ctx, invariants, runner);
        gates.push(invResult);
        if (!invResult.passed) {
          log(`[invariants] FAILED: ${invResult.detail}`);
          return buildResult({
            gates,
            config,
            store,
            sessionId,
            totalStart,
            logs,
            failedGate: "invariants",
            error: invResult.detail,
            edits,
            predicates: groundedPredicates
          });
        }
      }
    } else if (config.appUrl) {
      ctx.appUrl = config.appUrl;
      log(`[staging] Skipped (appUrl provided: ${config.appUrl})`);
      gates.push({
        gate: "staging",
        passed: true,
        detail: `Skipped: using provided appUrl ${config.appUrl}`,
        durationMs: 0
      });
      if (gateConfig.browser !== false) {
        log("[browser] Running Playwright validation...");
        const browserResult = await runBrowserGate(ctx);
        gates.push(browserResult);
        if (browserResult.screenshots) {
          browserScreenshots = browserResult.screenshots;
          log(`[browser] ${Object.keys(browserScreenshots).length} screenshot(s) captured for vision gate`);
        }
        if (!browserResult.passed) {
          log(`[browser] FAILED: ${browserResult.detail}`);
          return buildResult({
            gates,
            config,
            store,
            sessionId,
            totalStart,
            logs,
            failedGate: "browser",
            error: browserResult.detail,
            edits,
            predicates: groundedPredicates
          });
        }
      }
      if (gateConfig.http !== false) {
        const httpPredicates = groundedPredicates.filter(
          (p) => p.type === "http" || p.type === "http_sequence"
        );
        if (httpPredicates.length > 0) {
          log("[http] Running HTTP predicate validation...");
          const httpResult = await runHttpGate(ctx);
          gates.push(httpResult);
          if (!httpResult.passed) {
            log(`[http] FAILED: ${httpResult.detail}`);
            return buildResult({
              gates,
              config,
              store,
              sessionId,
              totalStart,
              logs,
              failedGate: "http",
              error: httpResult.detail,
              edits,
              predicates: groundedPredicates
            });
          }
        }
      }
      const invariants2 = config.invariants ?? loadInvariantsFile(config.appDir);
      if (gateConfig.invariants !== false && invariants2.length > 0) {
        log("[invariants] Running system health checks...");
        const invResult = await runInvariantsGate(ctx, invariants2, runner);
        gates.push(invResult);
        if (!invResult.passed) {
          log(`[invariants] FAILED: ${invResult.detail}`);
          return buildResult({
            gates,
            config,
            store,
            sessionId,
            totalStart,
            logs,
            failedGate: "invariants",
            error: invResult.detail,
            edits,
            predicates: groundedPredicates
          });
        }
      }
    } else if (gateConfig.staging !== false) {
      const reason = !dockerAvailable ? "Docker not available" : "No docker-compose file found";
      log(`[staging] Skipped: ${reason}`);
      gates.push({
        gate: "staging",
        passed: true,
        detail: `Skipped: ${reason}`,
        durationMs: 0
      });
    }
    if (gateConfig.vision === true && config.vision?.call) {
      if (browserScreenshots && Object.keys(browserScreenshots).length > 0) {
        const mergedScreenshots = { ...config.vision.screenshots ?? {}, ...browserScreenshots };
        ctx.config = {
          ...ctx.config,
          vision: {
            ...ctx.config.vision,
            screenshots: mergedScreenshots
          }
        };
        log(`[vision] Threading ${Object.keys(browserScreenshots).length} browser screenshot(s) to vision gate`);
      }
      log("[vision] Running vision model verification...");
      const visionResult = await runVisionGate(ctx);
      gates.push(visionResult);
      if (!visionResult.passed) {
        log(`[vision] FAILED: ${visionResult.detail} (triangulation will synthesize)`);
      }
    }
    {
      const triangulationResult = runTriangulationGate(gates, log);
      gates.push(triangulationResult);
      if (triangulationResult.triangulation.action === "rollback") {
        log(`[triangulation] ROLLBACK: ${triangulationResult.triangulation.reasoning}`);
        return buildResult({
          gates,
          config,
          store,
          sessionId,
          totalStart,
          logs,
          failedGate: "triangulation",
          error: triangulationResult.triangulation.reasoning,
          edits,
          predicates: groundedPredicates,
          triangulation: triangulationResult.triangulation
        });
      }
      if (triangulationResult.triangulation.action === "escalate") {
        log(`[triangulation] ESCALATE: ${triangulationResult.triangulation.reasoning}`);
      }
    }
    log("[verify] All gates passed");
    store.recordOutcome({
      timestamp: Date.now(),
      sessionId,
      goal: config.goal,
      success: true,
      changeType: classifyChangeType(edits.map((e) => e.file)),
      filesTouched: edits.map((e) => e.file),
      gatesFailed: []
    });
    if (config.learning !== "persistent") {
      store.cleanupSession(sessionId);
    }
    const containmentGate = gates.find((g) => g.gate === "G5");
    const triangulationGate = gates.find((g) => g.gate === "triangulation");
    return {
      success: true,
      gates,
      attestation: buildAttestation(gates, true, config.goal),
      timing: {
        totalMs: Date.now() - totalStart,
        perGate: Object.fromEntries(gates.map((g) => [g.gate, g.durationMs]))
      },
      effectivePredicates: groundedPredicates.map((p, i) => ({
        id: `p${i}`,
        type: p.type,
        fingerprint: fingerprints[i],
        description: p.description,
        groundingMiss: p.groundingMiss
      })),
      containment: containmentGate?.summary,
      constraintDelta: {
        before: store.getConstraintCount(),
        after: store.getConstraintCount(),
        seeded: []
      },
      triangulation: triangulationGate?.triangulation
    };
  } finally {
    if (runner) {
      log("[cleanup] Stopping staging container...");
      await runner.stop();
    }
    if (stageDir && (0, import_fs22.existsSync)(stageDir)) {
      try {
        (0, import_fs22.rmSync)(stageDir, { recursive: true, force: true });
      } catch {
      }
    }
  }
}
function buildResult(opts) {
  const { gates, config, store, sessionId, totalStart, failedGate, error, edits, predicates } = opts;
  const filesTouched = [...new Set(edits.map((e) => e.file))];
  const changeType = classifyChangeType(filesTouched);
  const signature = extractSignature(error);
  const failedFingerprints = predicates.filter((p) => p.groundingMiss).map((p) => predicateFingerprint(p));
  store.recordOutcome({
    timestamp: Date.now(),
    sessionId,
    goal: config.goal,
    success: false,
    changeType,
    filesTouched,
    gatesFailed: [failedGate],
    signature,
    failureKind: "app_failure",
    failedPredicateFingerprints: failedFingerprints.length > 0 ? failedFingerprints : void 0
  });
  const actionClass = classifyActionClass(edits);
  const seededConstraint = store.seedFromFailure({
    sessionId,
    source: gateToSource(failedGate),
    error,
    filesTouched,
    attempt: 1,
    changeType,
    signature,
    actionClass,
    failedPredicates: predicates.map((p) => ({
      type: p.type,
      selector: p.selector,
      property: p.property,
      expected: p.expected,
      path: p.path,
      method: p.method,
      table: p.table,
      pattern: p.pattern,
      expect: p.expect,
      steps: p.steps
    }))
  });
  const narrowing = {
    constraints: seededConstraint ? [{ id: seededConstraint.id, signature: seededConstraint.signature, type: seededConstraint.type, reason: seededConstraint.reason }] : [],
    resolutionHint: buildResolutionHint(failedGate, error, opts.violation),
    patternRecall: (() => {
      const r = store.getPatternRecall(error);
      return r ? [r] : void 0;
    })()
  };
  if (seededConstraint?.requires.bannedPredicateFingerprints) {
    narrowing.bannedFingerprints = seededConstraint.requires.bannedPredicateFingerprints;
  }
  const fingerprints = predicates.map((p) => predicateFingerprint(p));
  const containmentGate = gates.find((g) => g.gate === "G5");
  const constraintDelta = {
    before: store.getConstraintCount() - (seededConstraint ? 1 : 0),
    after: store.getConstraintCount(),
    seeded: seededConstraint ? [seededConstraint.signature] : []
  };
  if (config.learning !== "persistent") {
    store.cleanupSession(sessionId);
  }
  return {
    success: false,
    gates,
    narrowing,
    attestation: buildAttestation(gates, false, config.goal, failedGate),
    timing: {
      totalMs: Date.now() - totalStart,
      perGate: Object.fromEntries(gates.map((g) => [g.gate, g.durationMs]))
    },
    effectivePredicates: predicates.map((p, i) => ({
      id: `p${i}`,
      type: p.type,
      fingerprint: fingerprints[i],
      description: p.description,
      groundingMiss: p.groundingMiss
    })),
    containment: containmentGate?.summary,
    constraintDelta,
    triangulation: opts.triangulation
  };
}
var GATE_LABELS = {
  grounding: "grounding",
  F9: "syntax",
  K5: "constraints",
  G5: "containment",
  staging: "staging",
  browser: "browser",
  http: "http",
  invariants: "health-checks",
  vision: "vision",
  triangulation: "cross-check",
  infrastructure: "infrastructure",
  serialization: "data",
  config: "config",
  security: "security",
  a11y: "accessibility",
  performance: "performance",
  filesystem: "filesystem",
  access: "access",
  capacity: "capacity",
  contention: "concurrency",
  state: "state",
  temporal: "timing",
  propagation: "propagation",
  observation: "observation",
  goal: "goal",
  content: "content",
  hallucination: "hallucination"
};
function buildAttestation(gates, success, goal, failedGate) {
  const gateStr = gates.map((g) => `${GATE_LABELS[g.gate] ?? g.gate}${g.passed ? "\u2713" : "\u2717"}`).join(" ");
  const durationMs = gates.reduce((sum, g) => sum + g.durationMs, 0);
  if (success) {
    return [
      `VERIFIED${goal ? `: ${goal}` : ""}`,
      `Checks: ${gateStr}`,
      `Duration: ${durationMs}ms`
    ].join("\n");
  }
  const failed = gates.find((g) => !g.passed);
  const gateName = GATE_LABELS[failedGate ?? failed?.gate ?? ""] ?? failedGate ?? failed?.gate ?? "unknown";
  return [
    `NOT VERIFIED${goal ? `: ${goal}` : ""}`,
    `Checks: ${gateStr}`,
    `Stopped at: ${gateName}`,
    `Problem: ${failed?.detail ?? "unknown"}`,
    `Duration: ${durationMs}ms`
  ].join("\n");
}
function buildResolutionHint(gate, error, violation) {
  if (gate === "F9") {
    if (error.includes("not found")) return "The search string doesn't exist in the file. Read the file first and copy an exact substring.";
    if (error.includes("ambiguous")) return "The search string matches multiple places. Add more surrounding lines to make it unique.";
    return "The edits have syntax errors. Check brackets, quotes, and semicolons.";
  }
  if (gate === "K5") {
    if (violation?.banType === "predicate_fingerprint") {
      return "This exact approach already failed. Try a different CSS selector, expected value, or predicate type.";
    }
    if (violation?.banType === "radius_limit") {
      return `Too many files changed. Keep the edit to ${violation.reason?.match(/\d+/)?.[0] ?? "fewer"} files or less.`;
    }
    return "This strategy was tried before and failed. Try a fundamentally different approach.";
  }
  if (gate === "staging") return "The app failed to build or start. Check Dockerfile, dependencies, and startup code.";
  if (gate === "browser") return "The page doesn't look right after the edit. Check CSS computed styles in a browser.";
  if (gate === "http") return "The API endpoint returned an unexpected response. Check status codes and response body.";
  if (gate === "invariants") return "The edit broke something else. Health checks failed after applying the change.";
  if (gate === "filesystem") return "A file is missing, has wrong content, or wasn't created. Check paths and filenames.";
  if (gate === "infrastructure") return "Infrastructure doesn't match expectations. Check that resources exist and have the right attributes.";
  if (gate === "serialization") return "The JSON data doesn't match the expected shape. Check keys, types, and values.";
  if (gate === "config") return "A config value is wrong or missing. Check .env files, JSON configs, and key names.";
  if (gate === "security") return "Security issue detected. Check for XSS, SQL injection, hardcoded secrets, or missing auth.";
  if (gate === "a11y") return "Accessibility issue found. Check alt text, form labels, heading order, and ARIA attributes.";
  if (gate === "performance") return "Performance is below threshold. Check bundle size, image sizes, and connection count.";
  if (gate === "hallucination") return "That claim isn't true. Check the actual database schema, routes, CSS, or file contents.";
  return "Verification failed. Check the details above for what went wrong.";
}
function gateToSource(gate) {
  switch (gate) {
    case "F9":
      return "syntax";
    case "staging":
      return "staging";
    case "browser":
    case "http":
    case "filesystem":
    case "infrastructure":
    case "serialization":
    case "config":
    case "security":
    case "a11y":
    case "performance":
    case "hallucination":
      return "evidence";
    case "invariants":
      return "invariant";
    default:
      return "staging";
  }
}
function copyAppDir(src, dest) {
  const SKIP = /* @__PURE__ */ new Set(["node_modules", ".git", ".next", "dist", ".sovereign", ".verify", ".verify-tmp"]);
  (0, import_fs22.cpSync)(src, dest, {
    recursive: true,
    filter: (source) => {
      const name = source.split(/[/\\]/).pop() ?? "";
      return !SKIP.has(name);
    }
  });
}
var _invariantsCache = /* @__PURE__ */ new Map();
function loadInvariantsFile(appDir) {
  const cached = _invariantsCache.get(appDir);
  if (cached && Date.now() - cached.cachedAt < 5e3) return cached.result;
  const candidates = [
    (0, import_path22.join)(appDir, "invariants.json"),
    (0, import_path22.join)(appDir, ".verify", "invariants.json")
  ];
  for (const path of candidates) {
    if ((0, import_fs22.existsSync)(path)) {
      try {
        const result = JSON.parse((0, import_fs22.readFileSync)(path, "utf-8"));
        _invariantsCache.set(appDir, { result, cachedAt: Date.now() });
        return result;
      } catch {
      }
    }
  }
  const empty = [];
  _invariantsCache.set(appDir, { result: empty, cachedAt: Date.now() });
  return empty;
}

// src/action/github.ts
async function getPRDiff(token, owner, repo, prNumber) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3.diff"
    }
  });
  if (!res.ok) throw new Error(`Failed to get PR diff: ${res.status} ${res.statusText}`);
  return res.text();
}
async function getPRMetadata(token, owner, repo, prNumber) {
  const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json"
    }
  });
  if (!prRes.ok) throw new Error(`Failed to get PR: ${prRes.status}`);
  const pr = await prRes.json();
  const commitsRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=50`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json"
    }
  });
  const commits = commitsRes.ok ? await commitsRes.json() : [];
  const commitMessages = commits.map((c) => c.commit?.message ?? "").filter(Boolean);
  let issueTitle;
  const issueMatch = pr.body?.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i);
  if (issueMatch) {
    try {
      const issueRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueMatch[1]}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" }
      });
      if (issueRes.ok) {
        const issue = await issueRes.json();
        issueTitle = issue.title;
      }
    } catch {
    }
  }
  return {
    title: pr.title ?? "",
    body: pr.body ?? "",
    number: prNumber,
    headSha: pr.head?.sha ?? "",
    baseBranch: pr.base?.ref ?? "main",
    headBranch: pr.head?.ref ?? "",
    issueTitle,
    commitMessages
  };
}
async function getPRFiles(token, owner, repo, prNumber) {
  const files = [];
  let page = 1;
  while (true) {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" }
    });
    if (!res.ok) throw new Error(`Failed to get PR files: ${res.status}`);
    const batch = await res.json();
    if (batch.length === 0) break;
    files.push(...batch.map((f) => ({ filename: f.filename, status: f.status })));
    if (batch.length < 100) break;
    page++;
  }
  return files;
}
async function getFileContent(token, owner, repo, path, ref) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${ref}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" }
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.encoding === "base64" && data.content) {
    return Buffer.from(data.content, "base64").toString("utf-8");
  }
  return null;
}
async function postPRComment(token, owner, repo, prNumber, body) {
  const marker = "<!-- verify-action -->";
  const fullBody = `${marker}
${body}`;
  const commentsRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" }
  });
  if (commentsRes.ok) {
    const comments = await commentsRes.json();
    const existing = comments.find((c) => c.body?.includes(marker));
    if (existing) {
      await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ body: fullBody })
      });
      return;
    }
  }
  await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ body: fullBody })
  });
}

// src/action/comment.ts
function formatComment(result, opts) {
  const lines = [];
  const icon = result.success ? "\u2705" : "\u274C";
  lines.push(`## ${icon} Verify Agent Check`);
  lines.push("");
  const passed = result.gates.filter((g) => g.passed).length;
  const failed = result.gates.filter((g) => !g.passed).length;
  const total = result.gates.length;
  if (result.success) {
    lines.push(`**All ${total} gates passed.** This PR looks structurally sound.`);
  } else {
    lines.push(`**${failed} of ${total} gates failed.** Issues found in this PR.`);
  }
  lines.push("");
  lines.push("| Gate | Status | Detail |");
  lines.push("|------|--------|--------|");
  for (const g of result.gates) {
    const status = g.passed ? "\u2705 Pass" : "\u274C Fail";
    const detail = truncate(g.detail || "", 80);
    const name = formatGateName(g.gate);
    lines.push(`| ${name} | ${status} | ${detail} |`);
  }
  lines.push("");
  const failures = result.gates.filter((g) => !g.passed);
  if (failures.length > 0) {
    lines.push("### Issues");
    lines.push("");
    for (const g of failures) {
      lines.push(`**${formatGateName(g.gate)}:** ${g.detail}`);
      lines.push("");
    }
  }
  if (result.predicateResults && result.predicateResults.length > 0) {
    const predFailed = result.predicateResults.filter((p) => !p.passed);
    if (predFailed.length > 0) {
      lines.push("### Predicate Failures");
      lines.push("");
      for (const p of predFailed) {
        lines.push(`- **${p.type}**: expected \`${p.expected}\`, got \`${p.actual}\`${p.detail ? ` \u2014 ${p.detail}` : ""}`);
      }
      lines.push("");
    }
  }
  lines.push("<details>");
  lines.push("<summary>Details</summary>");
  lines.push("");
  if (opts?.predicateCount) lines.push(`- Predicates checked: ${opts.predicateCount}`);
  if (opts?.tiers) lines.push(`- Extraction tiers: ${opts.tiers.join(", ")}`);
  if (opts?.durationMs) lines.push(`- Duration: ${(opts.durationMs / 1e3).toFixed(1)}s`);
  lines.push(`- Gates run: ${total} (${passed} passed, ${failed} failed)`);
  lines.push(`- Timing: ${result.timing.totalMs}ms`);
  lines.push("");
  lines.push("Powered by [@sovereign-labs/verify](https://www.npmjs.com/package/@sovereign-labs/verify) \u2014 deterministic verification of agent edits.");
  lines.push("Questions? [GitHub Discussions](https://github.com/Born14/verify/discussions)");
  lines.push("");
  lines.push("</details>");
  return lines.join("\n");
}
function formatGateName(gate) {
  const names = {
    grounding: "Grounding",
    F9: "Syntax (F9)",
    K5: "Constraints (K5)",
    G5: "Containment (G5)",
    staging: "Staging",
    browser: "Browser",
    http: "HTTP",
    invariants: "Invariants",
    security: "Security",
    a11y: "Accessibility",
    performance: "Performance",
    access: "Access Control",
    temporal: "Temporal",
    propagation: "Propagation",
    state: "State",
    capacity: "Capacity",
    contention: "Contention",
    observation: "Observation",
    triangulation: "Triangulation",
    vision: "Vision",
    filesystem: "Filesystem",
    config: "Config",
    serialization: "Serialization",
    infrastructure: "Infrastructure",
    hallucination: "Hallucination",
    content: "Content"
  };
  return names[gate] ?? gate;
}
function truncate(s, max) {
  return s.length > max ? s.substring(0, max - 3) + "..." : s;
}

// src/action/migration-check.ts
var BLOCKING_SHAPES = /* @__PURE__ */ new Set(["DM-18"]);
var WARNING_SHAPES = /* @__PURE__ */ new Set(["DM-15", "DM-16", "DM-17"]);
async function checkMigrations(migrationFiles, priorMigrationsSql) {
  const errors = [];
  const allFindings = [];
  const filesChecked = [];
  const { loadModule: loadModule3 } = await Promise.resolve().then(() => __toESM(require_wasm(), 1));
  const { createEmptySchema: createEmptySchema2, applyMigrationSQL: applyMigrationSQL2 } = await Promise.resolve().then(() => (init_schema_loader(), schema_loader_exports));
  const { parseMigration: parseMigration2 } = await Promise.resolve().then(() => (init_spec_from_ast(), spec_from_ast_exports));
  const { runGroundingGate: runGroundingGate2 } = await Promise.resolve().then(() => (init_grounding_gate(), grounding_gate_exports));
  const { runSafetyGate: runSafetyGate2 } = await Promise.resolve().then(() => (init_safety_gate(), safety_gate_exports));
  await loadModule3();
  const schema = createEmptySchema2();
  for (const sql of priorMigrationsSql) {
    try {
      applyMigrationSQL2(schema, sql);
    } catch (err) {
    }
  }
  for (const [filePath, sql] of migrationFiles) {
    filesChecked.push(filePath);
    try {
      const spec = parseMigration2(sql, filePath);
      if (spec.meta.parseErrors.length > 0) {
        errors.push(`${filePath}: parse error \u2014 ${spec.meta.parseErrors[0]}`);
        continue;
      }
      const grounding = runGroundingGate2(spec, schema);
      const safety = runSafetyGate2(spec, schema);
      for (const f of [...grounding, ...safety]) {
        if (!BLOCKING_SHAPES.has(f.shapeId) && WARNING_SHAPES.has(f.shapeId)) {
          f.severity = "warning";
        }
        allFindings.push(f);
      }
      try {
        applyMigrationSQL2(schema, sql);
      } catch {
      }
    } catch (err) {
      errors.push(`${filePath}: ${err.message}`);
    }
  }
  const hasBlockingFindings = allFindings.some(
    (f) => f.severity === "error" && (BLOCKING_SHAPES.has(f.shapeId) || f.shapeId.startsWith("DM-0"))
  );
  return {
    passed: !hasBlockingFindings,
    findings: allFindings,
    filesChecked,
    schemaTableCount: schema.tables.size,
    errors
  };
}
function formatMigrationComment(result) {
  if (result.filesChecked.length === 0) return "";
  const lines = [];
  const icon = result.passed ? "\u2705" : "\u274C";
  lines.push(`### ${icon} Migration Verification`);
  lines.push("");
  lines.push(`Checked ${result.filesChecked.length} migration file(s) against ${result.schemaTableCount} tables in schema.`);
  lines.push("");
  if (result.findings.length === 0 && result.errors.length === 0) {
    lines.push("No issues found. Migration is structurally safe.");
    return lines.join("\n");
  }
  if (result.findings.length > 0) {
    lines.push("| Shape | Severity | File | Line | Finding |");
    lines.push("|-------|----------|------|------|---------|");
    for (const f of result.findings) {
      const sevIcon = f.severity === "error" ? "\u274C" : "\u26A0\uFE0F";
      const file = f.operation && "table" in f.operation ? f.operation.table : "";
      const line = f.location?.line ?? "";
      const msg = f.message.length > 120 ? f.message.slice(0, 117) + "..." : f.message;
      lines.push(`| \`${f.shapeId}\` | ${sevIcon} ${f.severity} | ${file} | ${line} | ${msg} |`);
    }
    lines.push("");
    const blocking = result.findings.filter((f) => f.severity === "error");
    if (blocking.length > 0) {
      lines.push("<details>");
      lines.push("<summary>How to acknowledge expected findings</summary>");
      lines.push("");
      lines.push("Add a comment to your migration file to suppress known-safe findings:");
      lines.push("```sql");
      const shapes = [...new Set(blocking.map((f) => f.shapeId))];
      for (const s of shapes) {
        lines.push(`-- verify: ack ${s} <reason why this is safe>`);
      }
      lines.push("```");
      lines.push("</details>");
      lines.push("");
    }
  }
  if (result.errors.length > 0) {
    lines.push("**Processing errors:**");
    for (const e of result.errors) {
      lines.push(`- ${e}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
function detectMigrationFiles(changedFiles) {
  const patterns = [
    /migrations?\/.*\.sql$/i,
    /migrate\/.*\.sql$/i,
    /db\/migrate\/.*\.sql$/i,
    /supabase\/migrations\/.*\.sql$/i
  ];
  const excludes = [
    /^scripts\//i,
    /^fixtures\//i,
    /^tests?\//i,
    /corpus\//i
  ];
  return changedFiles.filter(
    (f) => patterns.some((p) => p.test(f)) && !excludes.some((e) => e.test(f))
  );
}

// src/action/index.ts
async function run() {
  const startTime = Date.now();
  const token = process.env.GITHUB_TOKEN ?? process.env.INPUT_TOKEN ?? "";
  const appDir = process.env.INPUT_APP_DIR ?? process.env["INPUT_APP-DIR"] ?? ".";
  const intentEnabled = (process.env.INPUT_INTENT ?? "false") === "true";
  const apiKey = process.env.INPUT_API_KEY ?? process.env["INPUT_API-KEY"] ?? "";
  const provider = process.env.INPUT_PROVIDER ?? "gemini";
  const stagingEnabled = (process.env.INPUT_STAGING ?? "false") === "true";
  const commentEnabled = (process.env.INPUT_COMMENT ?? "true") === "true";
  const failOn = process.env.INPUT_FAIL_ON ?? process.env["INPUT_FAIL-ON"] ?? "error";
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    console.log("::error::Not running in GitHub Actions context (GITHUB_EVENT_PATH not set)");
    process.exit(1);
  }
  const { readFileSync: readFileSync22 } = await import("fs");
  const event = JSON.parse(readFileSync22(eventPath, "utf-8"));
  const prNumber = event.pull_request?.number ?? event.number;
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  if (!prNumber || !owner || !repo) {
    console.log("::error::Could not determine PR number or repository");
    process.exit(1);
  }
  if (!token) {
    console.log("::error::No GitHub token provided. Set GITHUB_TOKEN or use permissions: pull-requests: write");
    process.exit(1);
  }
  console.log(`Verify Action: ${owner}/${repo}#${prNumber}`);
  console.log(`  Mode: ${stagingEnabled ? "Full (staging)" : intentEnabled ? "Intent (LLM)" : "Structural (free)"}`);
  console.log(`  App dir: ${appDir}`);
  console.log("\n[1/4] Reading PR diff...");
  const diff = await getPRDiff(token, owner, repo, prNumber);
  const edits = parseDiff(diff);
  console.log(`  ${edits.length} edit(s) from diff`);
  if (edits.length === 0) {
    console.log("  No edits found in diff (binary-only or empty PR). Skipping.");
    setOutput("success", "true");
    setOutput("summary", "No edits to verify");
    return;
  }
  console.log("\n[2/4] Generating predicates...");
  const predicates = [];
  const tiers = [];
  const diffPreds = tier1Diff(edits);
  predicates.push(...diffPreds.filter((p) => p.expected !== "absent"));
  tiers.push("diff");
  console.log(`  Tier 1 (diff): ${diffPreds.length} predicates`);
  try {
    const { readdirSync: readdirSync14 } = await import("fs");
    const existingFiles = listFiles(appDir, readdirSync14);
    const crossFilePreds = tier2Context(edits, existingFiles);
    predicates.push(...crossFilePreds.filter((p) => p.expected !== "absent"));
    tiers.push("cross-file");
    console.log(`  Tier 2 (cross-file): ${crossFilePreds.length} predicates`);
  } catch {
    console.log("  Tier 2 (cross-file): skipped (could not read repo files)");
  }
  if (intentEnabled) {
    console.log("  Reading PR metadata...");
    const metadata = await getPRMetadata(token, owner, repo, prNumber);
    const intentPreds = tier3Intent(edits, {
      title: metadata.title,
      description: metadata.body,
      issueTitle: metadata.issueTitle,
      commitMessages: metadata.commitMessages
    });
    predicates.push(...intentPreds);
    tiers.push("intent-heuristic");
    console.log(`  Tier 3a (intent heuristic): ${intentPreds.length} predicates`);
    if (apiKey) {
      console.log(`  Tier 3b (LLM intent via ${provider}): generating...`);
      try {
        const llmPreds = await extractLLMPredicates(edits, metadata, apiKey, provider);
        predicates.push(...llmPreds);
        tiers.push(`intent-llm-${provider}`);
        console.log(`  Tier 3b (LLM intent): ${llmPreds.length} predicates`);
      } catch (err) {
        console.log(`  Tier 3b (LLM intent): failed \u2014 ${err.message}`);
      }
    }
  }
  console.log(`  Total: ${predicates.length} predicates`);
  console.log("\n[3/4] Running verify...");
  const { mkdirSync: mkdirS, writeFileSync: writeFS, rmSync: rmS } = await import("fs");
  const { dirname: dirN, join: joinP } = await import("path");
  const { tmpdir: tmpD } = await import("os");
  const prAppDir = joinP(tmpD(), `verify-action-${Date.now()}`);
  mkdirS(prAppDir, { recursive: true });
  for (const edit of edits) {
    try {
      const filePath = joinP(prAppDir, edit.file);
      mkdirS(dirN(filePath), { recursive: true });
      writeFS(filePath, (edit.search || "") + "\n" + (edit.replace || ""));
    } catch {
    }
  }
  const result = await verify(edits, predicates, {
    appDir: prAppDir,
    gates: {
      // Diff-only gates — all enabled (these work without Docker/repo cloning)
      // security, access, temporal, propagation, state, capacity, contention,
      // observation, containment (G5), constraints (K5) all fire on edits alone
      // Disabled: need Docker, Playwright, or full repo state
      grounding: false,
      // needs real repo source files for selector validation
      syntax: false,
      // needs real files for search string matching
      staging: stagingEnabled,
      browser: false,
      http: stagingEnabled,
      invariants: false,
      vision: false
    }
  });
  try {
    rmS(prAppDir, { recursive: true, force: true });
  } catch {
  }
  const passed = result.gates.filter((g) => g.passed).length;
  const failed = result.gates.filter((g) => !g.passed).length;
  console.log(`  Result: ${result.success ? "PASS" : "FAIL"} (${passed} passed, ${failed} failed)`);
  for (const g of result.gates) {
    if (!g.passed) console.log(`  \u274C ${g.gate}: ${g.detail?.substring(0, 80)}`);
  }
  console.log("\n[3b/4] Checking migrations...");
  let migrationResult = null;
  try {
    const prFiles = await getPRFiles(token, owner, repo, prNumber);
    const migrationPaths = detectMigrationFiles(prFiles.map((f) => f.filename));
    if (migrationPaths.length > 0) {
      console.log(`  Found ${migrationPaths.length} migration file(s): ${migrationPaths.join(", ")}`);
      const metadata = await getPRMetadata(token, owner, repo, prNumber);
      const migrationFiles = /* @__PURE__ */ new Map();
      for (const path of migrationPaths) {
        const content = await getFileContent(token, owner, repo, path, metadata.headSha);
        if (content) migrationFiles.set(path, content);
      }
      const priorSql = [];
      const scannedDirs = /* @__PURE__ */ new Set();
      for (const migPath of migrationPaths) {
        const isPrismaLayout = /\/migration\.sql$/i.test(migPath);
        const migDir = isPrismaLayout ? migPath.replace(/\/[^/]+\/migration\.sql$/i, "") : migPath.replace(/\/[^/]+$/, "");
        if (scannedDirs.has(migDir)) continue;
        scannedDirs.add(migDir);
        try {
          const dirRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(migDir)}?ref=${metadata.baseBranch}`,
            { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" } }
          );
          if (!dirRes.ok) continue;
          const dirContents = await dirRes.json();
          if (isPrismaLayout) {
            const priorDirs = dirContents.filter((f) => f.type === "dir").map((f) => f.path).sort();
            for (const subdir of priorDirs) {
              const sqlPath = `${subdir}/migration.sql`;
              if (migrationPaths.includes(sqlPath)) continue;
              const sql = await getFileContent(token, owner, repo, sqlPath, metadata.baseBranch);
              if (sql) priorSql.push(sql);
            }
          } else {
            const priorFiles = dirContents.filter((f) => f.name.endsWith(".sql") && f.type === "file").map((f) => f.path).filter((p) => !migrationPaths.includes(p)).sort();
            for (const pf of priorFiles) {
              const sql = await getFileContent(token, owner, repo, pf, metadata.baseBranch);
              if (sql) priorSql.push(sql);
            }
          }
        } catch {
        }
      }
      console.log(`  Schema bootstrap: ${priorSql.length} prior migration(s)`);
      migrationResult = await checkMigrations(migrationFiles, priorSql);
      console.log(`  Migration result: ${migrationResult.passed ? "PASS" : "FAIL"} (${migrationResult.findings.length} findings)`);
    } else {
      console.log("  No migration files in this PR.");
    }
  } catch (err) {
    console.log(`  Migration check error: ${err.message}`);
  }
  if (commentEnabled) {
    console.log("\n[4/4] Posting PR comment...");
    let comment = formatComment(result, {
      prNumber,
      predicateCount: predicates.length,
      tiers,
      durationMs: Date.now() - startTime
    });
    if (migrationResult) {
      comment += "\n\n" + formatMigrationComment(migrationResult);
    }
    await postPRComment(token, owner, repo, prNumber, comment);
    console.log("  Comment posted.");
  }
  const overallSuccess = result.success && (migrationResult?.passed ?? true);
  setOutput("success", String(overallSuccess));
  setOutput("gates-passed", result.gates.filter((g) => g.passed).map((g) => g.gate).join(","));
  setOutput("gates-failed", result.gates.filter((g) => !g.passed).map((g) => g.gate).join(","));
  const migSummary = migrationResult ? `, ${migrationResult.findings.length} migration finding(s)` : "";
  setOutput("summary", `${passed}/${passed + failed} gates passed${failed > 0 ? ` \u2014 ${result.gates.filter((g) => !g.passed).map((g) => g.gate).join(", ")} failed` : ""}${migSummary}`);
  if (failOn === "error" && !overallSuccess) {
    process.exit(1);
  }
}
async function extractLLMPredicates(edits, metadata, apiKey, provider = "gemini") {
  const diffSummary = edits.map(
    (e) => `${e.file}: "${e.search.substring(0, 60)}" \u2192 "${e.replace.substring(0, 60)}"`
  ).join("\n");
  const prompt = `Given this PR:
Title: ${metadata.title}
Description: ${(metadata.body || "").substring(0, 500)}

Diff summary:
${diffSummary}

What should be true about the codebase AFTER this PR is applied?
Return a JSON array of assertions. Each assertion: { "file": "path", "pattern": "text that should exist", "reason": "why" }
Only include specific, testable assertions. Max 5.`;
  const text = await callLLM(prompt, apiKey, provider);
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  try {
    const assertions = JSON.parse(jsonMatch[0]);
    return assertions.filter((a) => a.file && a.pattern).map((a) => ({
      type: "content",
      file: a.file,
      pattern: a.pattern,
      description: a.reason || `LLM: "${a.pattern}" should exist in ${a.file}`
    }));
  } catch {
    return [];
  }
}
async function callLLM(prompt, apiKey, provider) {
  switch (provider) {
    case "gemini": {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 500 }
        })
      });
      if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    }
    case "openai": {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_tokens: 500
        })
      });
      if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? "";
    }
    case "anthropic": {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 500,
          messages: [{ role: "user", content: prompt }]
        })
      });
      if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
      const data = await res.json();
      return data.content?.[0]?.text ?? "";
    }
    default:
      throw new Error(`Unknown provider: ${provider}. Use gemini, openai, or anthropic.`);
  }
}
function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const { appendFileSync: appendFileSync2 } = require("fs");
    appendFileSync2(outputFile, `${name}=${value}
`);
  }
  console.log(`::set-output name=${name}::${value}`);
}
function listFiles(dir, readdirSync14, prefix = "") {
  const files = [];
  const skip = /* @__PURE__ */ new Set(["node_modules", ".git", ".next", "dist", ".verify", "__pycache__"]);
  try {
    const entries = readdirSync14(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        files.push(...listFiles(`${dir}/${entry.name}`, readdirSync14, rel));
      } else {
        files.push(rel);
      }
    }
  } catch {
  }
  return files;
}
if (process.env.GITHUB_ACTIONS) {
  run().catch((err) => {
    console.log(`::error::${err.message}`);
    process.exit(1);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  callLLM
});
