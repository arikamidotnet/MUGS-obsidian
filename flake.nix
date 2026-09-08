{
  description = "MUGS — Multi-User Git Sync Obsidian plugin";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  # NOTE: we deliberately avoid `nixpkgs.lib.genAllSystems` and flake-utils.
  # This sandbox's nixpkgs flake input exposes a broken `lib` output (its own
  # `lib = lib.extend (...)` drops genAllSystems), so we build the per-system
  # outputs with plain `import nixpkgs {}` + builtins.listToAttrs instead.
  outputs = { self, nixpkgs }:
    let
      version = "0.1.0";

      mkSystem = system:
        let
          pkgs = import nixpkgs { inherit system; };

          # Reproducible npm dependency set: pins package-lock.json from package.json.
          nodeModules = pkgs.importNpmLockfile {
            fromPackageJson = ./package.json;
          };
        in
        {
          # Build environment: `nix develop` gives Node.js 20 + git + pinned deps,
          # so `npm run build`, `npm test`, and `npm run bench` work exactly as
          # they do with a manual npm setup. The nix-provided esbuild is added to
          # PATH so the npm esbuild postinstall reuses its platform binary instead
          # of downloading from the CDN (which needs network in a sandbox).
          devShells.default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_20
              pkgs.git
              pkgs.esbuild           # provides a platform binary for esbuild's postinstall
              pkgs.coreutils
            ];
          };

          # Hermetic production build: emits main.js, manifest.json, versions.json.
          packages.default = pkgs.buildNpmPackage {
            pname = "mugs-obsidian";
            inherit version;
            src = ./.;

            nodeModules = nodeModules;

            buildInputs = [ pkgs.nodejs_20 pkgs.esbuild ];

            # tsc type-checks, then esbuild emits the minified bundle.
            buildScript = "npm run build";

            # main.js + manifest.json land in $out (BRAT-consumable layout);
            # versions.json is generated from the Nix version so it stays DRY.
            installPhase = ''
              mkdir -p $out
              cp main.js $out/
              cp manifest.json $out/
              echo ${builtins.toJSON { mugs-obsidian = version; }} > $out/versions.json
            '';
          };

          formatter = pkgs.prettier;
        };
    in
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
    in
    {
      # Output-first convention: .#devShells.x86_64-linux, .#packages.x86_64-linux
      devShells = builtins.listToAttrs (map (s: { name = s; value = (mkSystem s).devShells.default; }) systems);
      packages = builtins.listToAttrs (map (s: { name = s; value = (mkSystem s).packages.default; }) systems);
      formatter = builtins.listToAttrs (map (s: { name = s; value = (mkSystem s).formatter; }) systems);
    };
}
