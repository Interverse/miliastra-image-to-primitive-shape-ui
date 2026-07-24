package main

// cli: a drop-in, DETERMINISTIC replacement for the fogleman `primitive` binary,
// used by the e2e parity harness. It mirrors third_party/primitive/main.go's
// flag handling and output, with two differences required by the parity
// contract (docs in tests/parity/fill/README.md):
//
//   * -j (workers) is IGNORED; the model always runs with ONE worker, so the
//     search is deterministic (no goroutine race over the result channel).
//   * -seed <int64> seeds worker.Rnd deterministically. Without it, the binary
//     time-seeds like the real primitive (non-deterministic).
//
// Everything else — flag parsing order, the -m/-n shape-config pairing, the
// n=1000/age=100/m=16 search inside Model.Step, and the SVG/PNG writers — is the
// unmodified primitive package, so the emitted SVG is byte-identical to what the
// real binary would produce for that (input, settings, seed) with one worker.

import (
	"flag"
	"fmt"
	"log"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/fogleman/primitive/primitive"
	"github.com/nfnt/resize"
)

type flagArray []string

func (i *flagArray) String() string { return strings.Join(*i, ", ") }
func (i *flagArray) Set(value string) error {
	*i = append(*i, value)
	return nil
}

type shapeConfig struct {
	Count  int
	Mode   int
	Alpha  int
	Repeat int
}

type shapeConfigArray []shapeConfig

func runCLI(argv []string) {
	fs := flag.NewFlagSet("primitive", flag.ExitOnError)

	var (
		input      string
		outputs    flagArray
		background string
		alpha      int
		inputSize  int
		outputSize int
		mode       int
		workers    int
		repeat     int
		seed       int64
		configs    shapeConfigArray
	)
	// -n appends a shape config capturing the current -m/-a/-rep, in arg order.
	nSet := func(value string) error {
		nn, _ := strconv.ParseInt(value, 0, 0)
		configs = append(configs, shapeConfig{int(nn), mode, alpha, repeat})
		return nil
	}

	fs.StringVar(&input, "i", "", "input image path")
	fs.Var(&outputs, "o", "output image path")
	fs.Func("n", "number of primitives", nSet)
	fs.StringVar(&background, "bg", "", "background color (hex)")
	fs.IntVar(&alpha, "a", 128, "alpha value")
	fs.IntVar(&inputSize, "r", 256, "resize large input images to this size")
	fs.IntVar(&outputSize, "s", 1024, "output image size")
	fs.IntVar(&mode, "m", 1, "shape mode")
	fs.IntVar(&workers, "j", 0, "IGNORED (parity: always 1 worker)")
	fs.IntVar(&repeat, "rep", 0, "extra shapes per iteration")
	fs.Int64Var(&seed, "seed", math.MinInt64, "deterministic RNG seed (parity)")
	// Accept-and-ignore flags the real binary has, so invocations don't fail.
	var nth int
	var v, vv bool
	fs.IntVar(&nth, "nth", 1, "save every Nth frame")
	fs.BoolVar(&v, "v", false, "verbose")
	fs.BoolVar(&vv, "vv", false, "very verbose")

	if err := fs.Parse(argv); err != nil {
		log.Fatal(err)
	}
	if input == "" || len(outputs) == 0 || len(configs) == 0 {
		fmt.Fprintln(os.Stderr, "usage: harness -i input -o output -n count [-m mode -bg hex -s size -seed N]")
		os.Exit(1)
	}
	if len(configs) == 1 {
		configs[0].Mode = mode
		configs[0].Alpha = alpha
		configs[0].Repeat = repeat
	}

	// Seed: deterministic if -seed given, else time-seeded like the real binary.
	if seed == math.MinInt64 {
		seed = time.Now().UTC().UnixNano()
	}

	input0, err := primitive.LoadImage(input)
	if err != nil {
		log.Fatal(err)
	}
	if inputSize > 0 {
		input0 = resize.Thumbnail(uint(inputSize), uint(inputSize), input0, resize.Bilinear)
	}

	var bg primitive.Color
	if background == "" {
		bg = primitive.MakeColor(primitive.AverageImageColor(input0))
	} else {
		bg = primitive.MakeHexColor(background)
	}

	// Parity: ALWAYS one worker; override its RNG with the fixed seed.
	model := primitive.NewModel(input0, bg, outputSize, 1)
	model.Workers[0].Rnd = rand.New(rand.NewSource(seed))

	for _, config := range configs {
		for i := 0; i < config.Count; i++ {
			model.Step(primitive.ShapeType(config.Mode), config.Alpha, config.Repeat)
		}
	}

	for _, output := range outputs {
		ext := strings.ToLower(filepath.Ext(output))
		if output == "-" {
			ext = ".svg"
		}
		switch ext {
		case ".png":
			check(primitive.SavePNG(output, model.Context.Image()))
		case ".jpg", ".jpeg":
			check(primitive.SaveJPG(output, model.Context.Image(), 95))
		case ".svg":
			check(primitive.SaveFile(output, model.SVG()))
		default:
			log.Fatalf("unrecognized file extension: %s", ext)
		}
	}
}

func check(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
