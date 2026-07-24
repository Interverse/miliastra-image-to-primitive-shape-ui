package main

import (
	"os"
)

// Dispatch: a bare first arg that names a parity subcommand runs that; anything
// else (notably a leading "-flag") runs the primitive.exe-compatible CLI so the
// e2e harness can invoke this binary as a drop-in for the real `primitive`.
func main() {
	if len(os.Args) >= 2 {
		switch os.Args[1] {
		case "rng":
			runRNG()
			return
		case "gomath":
			runGoMath()
			return
		case "gofmt":
			runGoFmt()
			return
		case "raster":
			runRaster()
			return
		case "trace":
			runTrace()
			return
		}
	}
	runCLI(os.Args[1:])
}
