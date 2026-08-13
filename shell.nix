let
  pkgs = import (import ./npins).nixpkgs {};
in pkgs.mkShell {
  packages = [
    pkgs.nodejs_22
    pkgs.pi-coding-agent
  ];
}
