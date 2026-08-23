// 2026-08-23: importai ir simboliai NEBE tik TypeScript'ui.
//
// Pavyzdžiai imti iš tikrų framework'ų formų (Django/pytest, Laravel/PSR-4, ASP.NET Core, MSBuild),
// o ne iš sintetinių eilučių: reikalavimas buvo „veikti ant visų framework'ų šiomis kalbomis", tad
// testas turi rodyti būtent tas formas, kurias tie framework'ai rašo.
import assert from "node:assert/strict";
import test from "node:test";
import { indexPythonSource } from "../application/code-intelligence/indexing/python-indexer.js";
import { indexPhpSource } from "../application/code-intelligence/indexing/php-indexer.js";
import { indexCSharpSource } from "../application/code-intelligence/indexing/csharp-indexer.js";
import { indexDotnetProject } from "../application/code-intelligence/indexing/dotnet-indexer.js";
import { hasLexicalIndexer, parseComposerPsr4 } from "../application/code-intelligence/indexing/language-indexer.js";
import { codeIndexLanguageCapabilities } from "../application/code-intelligence/indexing/language-capabilities.js";
import type { CodeIndexFile, CodeIndexLanguage } from "../application/code-intelligence/indexing/types.js";

function fileOf(path: string, language: CodeIndexLanguage): CodeIndexFile {
  return { path, hash: "h", size: 0, language, kind: "source", imports: [], exports: [], symbols: [], isTest: false };
}

test("Python: absoliutūs ir reliatyvūs importai, `__all__` nugali konvenciją", () => {
  const source = [
    "# import comment_should_not_count",
    "import os",
    "import django.db as db, json",
    "from django.db import models",
    "from .models import User",
    "from ..shared.util import helper",
    '"""from docstring import nothing"""',
    "",
    "__all__ = ['PublicThing', '_KeptPrivateByName']",
    "",
    "class PublicThing:",
    "    def method_not_a_top_level_symbol(self):",
    "        pass",
    "",
    "def _KeptPrivateByName():",
    "    pass",
    "",
    "async def not_in_all():",
    "    pass",
  ].join("\n");

  const known = new Set(["app/models.py", "shared/util.py"]);
  const result = indexPythonSource(fileOf("app/views.py", "python"), source, known);

  assert.deepEqual(result.file.imports, [
    "app/models.py",
    "django.db",
    "json",
    "os",
    "shared/util.py",
  ], "reliatyvūs virsta repo keliais; absoliutūs lieka moduliais; komentaras ir docstring'as neskaitomi");

  assert.deepEqual(result.symbols.map((symbol) => [symbol.name, symbol.kind, symbol.exported]), [
    ["PublicThing", "class", true],
    ["_KeptPrivateByName", "function", true],
    ["not_in_all", "function", false],
  ], "`__all__` laimi prieš pabraukimo konvenciją abiem kryptimis");

  const cls = result.symbols[0];
  assert.equal(cls?.line, 11, "eilutės numeris tikras, nes komentarai keičiami tarpais, o ne trinami");
  assert.ok((cls?.endLine ?? 0) > (cls?.line ?? 0), "klasės blokas turi pabaigą");
});

// 2026-08-23 (operatoriaus radinys): absoliutus importas likdavo tekstiniu net tada, kai failas
// projekte VIENAREIKŠMIŠKAI egzistuoja. Pagrindimas „be sys.path spėti reikštų išgalvoti briauną"
// galioja tik esant keliems kandidatams; esant vienam, tai nebe spėjimas, o įrodymas.
test("Python: absoliutus importas išsprendžiamas, kai kandidatas VIENAS", () => {
  const known = new Set(["app/models.py", "app/views.py", "app/pkg/__init__.py"]);
  const resolved = indexPythonSource(
    fileOf("app/views.py", "python"),
    "from app.models import X\nimport app.pkg\nimport os\n",
    known,
  );

  assert.deepEqual(resolved.file.imports, ["app/models.py", "app/pkg/__init__.py", "os"], [
    "modulis su vienu kandidatu virsta keliu;",
    "pakuotė randama per __init__.py;",
    "išorinis `os` lieka moduliu",
  ].join(" "));

  // Dviprasmybė atmetama — ta pati taisyklė kaip kanoninėje `resolveTaskNode` rezoliucijoje.
  const ambiguous = indexPythonSource(
    fileOf("x.py", "python"),
    "from app.models import X\n",
    new Set(["app/models.py", "src/app/models.py", "x.py"]),
  );
  assert.deepEqual(ambiguous.file.imports, ["app.models"], "du kandidatai — tyli teisinga pusė yra „nežinau\"");
});

test("PHP: PSR-4 masyvas yra PAIEŠKOS SEKA, ne pirmas kandidatas", () => {
  // Laravel/Symfony projektuose tai reali forma: `"App\\": ["src/", "app/"]`.
  const psr4 = parseComposerPsr4(JSON.stringify({ autoload: { "psr-4": { "App\\": ["src/", "app/"] } } }));
  const result = indexPhpSource(
    fileOf("c.php", "php"),
    "<?php\nuse App\\Models\\User;\n",
    new Set(["app/Models/User.php", "c.php"]),
    psr4,
  );

  assert.deepEqual(result.file.imports, ["app/Models/User.php"], "failas antrajame kataloge irgi randamas");
});

test("PHP: PSR-4 `use` virsta repo keliu; eksportai — pliki vardai", () => {
  const composer = JSON.stringify({
    autoload: { "psr-4": { "App\\": "app/" } },
    "autoload-dev": { "psr-4": { "Tests\\": "tests/" } },
  });
  const psr4 = parseComposerPsr4(composer);

  const source = [
    "<?php",
    "namespace App\\Http\\Controllers;",
    "",
    "use App\\Models\\User;",
    "use Illuminate\\Http\\Request;",
    "use function App\\Support\\helper;",
    "// use App\\Models\\Ignored;",
    "",
    "final class UserController extends Controller {",
    "    public function index() { return 1; }",
    "}",
    "",
    "interface Marker {}",
  ].join("\n");

  const known = new Set(["app/Models/User.php"]);
  const result = indexPhpSource(fileOf("app/Http/Controllers/UserController.php", "php"), source, known, psr4);

  assert.ok(result.file.imports.includes("app/Models/User.php"), "PSR-4 prefiksas išspręstas į failą");
  assert.ok(result.file.imports.includes("Illuminate\\Http\\Request"), "vendor nuoroda lieka vardu");
  assert.equal(result.file.imports.includes("App\\Models\\Ignored"), false, "užkomentuotas `use` neskaitomas");

  assert.deepEqual(result.symbols.map((symbol) => [symbol.name, symbol.kind]), [
    ["UserController", "class"],
    ["Marker", "interface"],
  ]);
  // Eksportai laikomi PLIKAIS vardais visose kalbose: iš jų statomos `exports` briaunos į
  // `failas#vardas`, ir namespace'u kvalifikuotas vardas rodytų į nesamą simbolio ID.
  assert.deepEqual(result.file.exports, ["Marker", "UserController"]);
});

test("C#: visos `using` formos; `internal` NĖRA eksportas", () => {
  const source = [
    "global using System.Linq;",
    "using System;",
    "using static System.Math;",
    "using Json = System.Text.Json;",
    "// using Ignored.Namespace;",
    "namespace Api.Controllers;",
    "",
    "[ApiController]",
    "public sealed class UsersController : ControllerBase",
    "{",
    "    public int Count => 1;",
    "}",
    "",
    "internal record UserDto(int Id);",
    "",
    "public enum Role { Admin, User }",
  ].join("\n");

  const result = indexCSharpSource(fileOf("src/Api/UsersController.cs", "csharp"), source);

  assert.deepEqual(result.file.imports, ["System", "System.Linq", "System.Math", "System.Text.Json"], "alias'o atveju importas yra TAIKINYS");
  assert.deepEqual(result.symbols.map((symbol) => [symbol.name, symbol.kind, symbol.exported]), [
    ["UsersController", "class", true],
    ["UserDto", "class", false],
    ["Role", "enum", true],
  ], "`internal` yra numatytoji reikšmė, tad tylėjimas reiškia „ne eksportas\"");
});

test(".NET: `.csproj` ir `.sln` duoda projektų grafą, o ne kalbos importus", () => {
  const known = new Set(["src/Core/Core.csproj", "src/Api/Api.csproj"]);

  const csproj = [
    '<Project Sdk="Microsoft.NET.Sdk.Web">',
    "  <ItemGroup>",
    '    <ProjectReference Include="..\\Core\\Core.csproj" />',
    '    <PackageReference Include="Serilog" Version="3.1.1" />',
    "    <!-- <ProjectReference Include=\"..\\Disabled\\Disabled.csproj\" /> -->",
    "  </ItemGroup>",
    '  <Target Name="PostBuildCopy" AfterTargets="Build" />',
    "  <PropertyGroup><AssemblyName>Company.Api</AssemblyName></PropertyGroup>",
    "</Project>",
  ].join("\n");

  const project = indexDotnetProject(fileOf("src/Api/Api.csproj", "dotnet"), csproj, known);
  assert.ok(project.file.imports.includes("src/Core/Core.csproj"), "ProjectReference išspręstas į repo kelią");
  assert.ok(project.file.imports.includes("Serilog"), "PackageReference lieka NuGet vardu");
  assert.ok(project.file.imports.includes("Microsoft.NET.Sdk.Web"), "SDK fiksuojamas — jis lemia framework'ą");
  assert.equal(
    project.file.imports.some((entry) => entry.includes("Disabled")),
    false,
    "XML komentare išjungta nuoroda NĖRA briauna",
  );
  assert.deepEqual(project.symbols.map((symbol) => symbol.name).sort(), ["Company.Api", "PostBuildCopy"]);

  const sln = [
    'Project("{FAE04EC0-0301-11D1-9B0E-00A0C91BC942}") = "Core", "src\\Core\\Core.csproj", "{111}"',
    'Project("{FAE04EC0-0301-11D1-9B0E-00A0C91BC942}") = "Api", "src\\Api\\Api.csproj", "{222}"',
  ].join("\n");

  const solution = indexDotnetProject(fileOf("App.sln", "dotnet"), sln, known);
  assert.deepEqual(solution.file.imports, ["src/Api/Api.csproj", "src/Core/Core.csproj"]);
  assert.deepEqual(solution.symbols.map((symbol) => symbol.name), ["Core", "Api"]);
});

// Iki 2026-08-23 `codeIndexLanguageCapabilities` vėliavėlės neturėjo NĖ VIENO skaitytojo: jos buvo
// dokumentacija kode, ir jos MELAVO (JavaScript buvo pažymėtas `extracts_imports: false`, nors tą
// patį AST kelią jis galėjo eiti visą laiką). Deklaracija, kurios niekas netikrina, nėra garantija —
// tad lentelė čia surišama su tikru dispečeriu.
test("gate: galimybių lentelė atitinka tai, ką iš tikrųjų turime", () => {
  const ecmaScript = new Set<CodeIndexLanguage>(["typescript", "javascript"]);

  for (const capability of codeIndexLanguageCapabilities) {
    const probe = fileOf(`probe${capability.extensions[0] ?? ".txt"}`, capability.language);
    const handled = ecmaScript.has(capability.language) || hasLexicalIndexer(probe);

    assert.equal(
      capability.extracts_imports,
      handled,
      `${capability.language}: extracts_imports=${String(capability.extracts_imports)}, bet ištraukėjas ${handled ? "YRA" : "NĖRA"}`,
    );
    assert.equal(
      capability.extracts_symbols,
      handled,
      `${capability.language}: extracts_symbols nesutampa su tikrove`,
    );
    // `parser` irgi turi sakyti tiesą: vardas, aprašantis nebeegzistuojantį būdą, klaidina lygiai
    // taip pat kaip pasenusi antraštė (2026-08-23 — TypeScript įrašas skelbė `regex-ts-indexer`,
    // nors AST naudojamas nuo task 1105b).
    assert.equal(
      /regex/i.test(capability.parser),
      false,
      `${capability.language}: parseris pavadintas "${capability.parser}", nors regex ištraukimo nebėra`,
    );
  }
});

test("sugadintas composer.json NĖRA klaida — tik nėra PSR-4 žemėlapio", () => {
  assert.equal(parseComposerPsr4("{ not json").size, 0);
  assert.equal(parseComposerPsr4(undefined).size, 0);
  // PSR-4 masyvas yra PAIEŠKOS SEKA: išsaugomi VISI katalogai ir jų tvarka, nes failas gali gulėti
  // antrajame (2026-08-23 — anksčiau buvo imamas tik pirmas).
  assert.deepEqual(parseComposerPsr4(JSON.stringify({ autoload: { "psr-4": { "A\\": ["a/", "b/"] } } })).get("A\\"), ["a/", "b/"]);
  assert.deepEqual(parseComposerPsr4(JSON.stringify({ autoload: { "psr-4": { "A\\": "a/" } } })).get("A\\"), ["a/"]);
});
