let
  pkgs = import (import ./npins).nixpkgs {};
in pkgs.mkShell {
  packages = [
    pkgs.pi-coding-agent
  ];
}
