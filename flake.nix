{
  description = "How far has nixos-unstable / nixpkgs-unstable been built on Hydra?";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.writeShellApplication {
            name = "isitbuilt-scanner";
            runtimeInputs = [ pkgs.bun ];
            text = ''
              exec bun ${self}/src/scanner.ts --config ${self}/config.json "$@"
            '';
          };
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.actionlint
              pkgs.bun
            ];
          };
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          tests =
            pkgs.runCommand "isitbuilt-tests"
              {
                nativeBuildInputs = [
                  pkgs.actionlint
                  pkgs.bun
                ];
              }
              ''
                cp -R ${self} source
                chmod -R u+w source
                cd source
                bun test tests/
                actionlint .github/workflows/ci.yml .github/workflows/update.yml
                touch "$out"
              '';
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
