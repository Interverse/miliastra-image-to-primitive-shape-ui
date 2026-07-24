package main

// trace: generates golden step-by-step traces of the primitive core for a
// matrix of (image, seed, shape-config, search-params) cases, so the JS port
// can be validated bit-exactly. For each committed shape it records the shape
// parameters, the chosen color (RGBA; A is the alpha), and the model score
// (float64 bits). It also embeds the straight (non-premultiplied) NRGBA target
// bytes (base64) so the JS side premultiplies identically.
//
// The per-step search is reconstructed from the exported Worker/Model methods
// so trace cases can use lighter (n,age,m) than Model.Step's hardcoded
// 1000/100/16 — bit-exactness is independent of those counts, and the e2e test
// exercises the full path. Writes trace_golden.json directly (no BOM).

import (
	"encoding/base64"
	"encoding/json"
	"image"
	"math"
	"math/rand"
	"os"
	"strconv"

	"github.com/fogleman/primitive/primitive"
)

type traceStep struct {
	ShapeType int       `json:"shapeType"`
	Tri       *[6]int   `json:"tri,omitempty"`  // x1,y1,x2,y2,x3,y3
	Rect      *[5]int   `json:"rect,omitempty"` // x,y,sx,sy,angle
	Ell       *[5]string `json:"ell,omitempty"` // x,y,rx,ry,angle as float64 bits
	Color     [4]int    `json:"color"`          // R,G,B,A (A is alpha)
	ScoreBits string    `json:"scoreBits"`      // model score float64 bits
}

type traceCase struct {
	Name        string      `json:"name"`
	W           int         `json:"w"`
	H           int         `json:"h"`
	Bg          string      `json:"bg"`
	Seed        int64       `json:"seed"`
	Configs     [][2]int    `json:"configs"` // [mode,count]...
	N           int         `json:"n"`
	Age         int         `json:"age"`
	M           int         `json:"m"`
	StraightB64 string      `json:"straight"` // base64 of w*h*4 straight NRGBA
	Steps       []traceStep `json:"steps"`
}

// makeTarget builds a deterministic straight NRGBA image (pattern by name).
func makeTarget(w, h int, pattern string, withAlpha bool) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	pr := rand.New(rand.NewSource(0x5eed1234)) // fixed, independent of model seed
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			i := img.PixOffset(x, y)
			var r, g, b, a uint8 = 0, 0, 0, 255
			switch pattern {
			case "grad":
				r = uint8((x * 255) / maxi(w-1, 1))
				g = uint8((y * 255) / maxi(h-1, 1))
				b = uint8(((x + y) * 255) / maxi(w+h-2, 1))
			case "blocks":
				bx := (x / 8) % 3
				by := (y / 8) % 3
				r = uint8((bx * 120) + 15)
				g = uint8((by * 120) + 15)
				b = uint8(((bx + by) * 60) + 20)
			default: // "noise"
				r = uint8(pr.Intn(256))
				g = uint8(pr.Intn(256))
				b = uint8(pr.Intn(256))
			}
			if withAlpha {
				// radial-ish alpha falloff plus a stripe of holes
				cx, cy := float64(w)/2, float64(h)/2
				dx, dy := float64(x)-cx, float64(y)-cy
				d := math.Sqrt(dx*dx + dy*dy)
				av := 255.0 - d*(255.0/(math.Max(cx, cy)+1))
				if av < 0 {
					av = 0
				}
				if (x+y)%7 == 0 {
					av = 0
				}
				a = uint8(av)
			}
			img.Pix[i+0] = r
			img.Pix[i+1] = g
			img.Pix[i+2] = b
			img.Pix[i+3] = a
		}
	}
	return img
}

func maxi(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func fbits(f float64) string { return strconv.FormatUint(math.Float64bits(f), 10) }

// customStep reconstructs Model.Step for one worker with explicit search params.
func customStep(model *primitive.Model, t primitive.ShapeType, n, age, m int) {
	worker := model.Workers[0]
	worker.Init(model.Current, model.Score)
	state := worker.BestHillClimbState(t, 0, n, age, m)
	model.Add(state.Shape, state.Alpha)
}

func runTrace() {
	type spec struct {
		name      string
		w, h      int
		pattern   string
		withAlpha bool
		bg        string
		configs   [][2]int
		n, age, m int
	}
	specs := []spec{
		{"grad_circle", 64, 48, "grad", false, "ffffff", [][2]int{{7, 8}}, 300, 60, 6},
		{"grad_rect", 64, 48, "grad", false, "ffffff", [][2]int{{5, 8}}, 300, 60, 6},
		{"grad_tri", 64, 48, "grad", false, "ffffff", [][2]int{{1, 8}}, 300, 60, 6},
		{"blocks_mixed", 56, 56, "blocks", false, "ffffff", [][2]int{{7, 4}, {5, 4}, {1, 4}}, 300, 60, 6},
		{"noise_circle", 48, 40, "noise", false, "ffffff", [][2]int{{7, 8}}, 300, 60, 6},
		{"alpha_circle", 48, 48, "grad", true, "ffffff00", [][2]int{{7, 8}}, 300, 60, 6},
		{"alpha_mixed", 48, 48, "blocks", true, "ffffff00", [][2]int{{7, 3}, {5, 3}, {1, 3}}, 300, 60, 6},
		// A couple of full-search cases (matches Model.Step's 1000/100/16).
		{"full_circle", 40, 32, "grad", false, "ffffff", [][2]int{{7, 4}}, 1000, 100, 16},
		{"full_mixed", 40, 32, "blocks", false, "ffffff", [][2]int{{7, 2}, {5, 2}, {1, 2}}, 1000, 100, 16},
	}
	seeds := []int64{1, 42}

	cases := []traceCase{}
	for _, sp := range specs {
		for _, seed := range seeds {
			img := makeTarget(sp.w, sp.h, sp.pattern, sp.withAlpha)
			var bg primitive.Color
			bg = primitive.MakeHexColor(sp.bg)
			size := sp.w
			if sp.h > size {
				size = sp.h
			}
			model := primitive.NewModel(img, bg, size, 1)
			model.Workers[0].Rnd = rand.New(rand.NewSource(seed))

			tc := traceCase{
				Name: sp.name, W: sp.w, H: sp.h, Bg: sp.bg, Seed: seed,
				Configs: sp.configs, N: sp.n, Age: sp.age, M: sp.m,
				StraightB64: base64.StdEncoding.EncodeToString(img.Pix),
			}
			for _, cfg := range sp.configs {
				mode, count := cfg[0], cfg[1]
				for i := 0; i < count; i++ {
					customStep(model, primitive.ShapeType(mode), sp.n, sp.age, sp.m)
					idx := len(model.Shapes) - 1
					shape := model.Shapes[idx]
					col := model.Colors[idx]
					score := model.Scores[idx]
					st := traceStep{
						ShapeType: mode,
						Color:     [4]int{col.R, col.G, col.B, col.A},
						ScoreBits: fbits(score),
					}
					switch s := shape.(type) {
					case *primitive.Triangle:
						st.Tri = &[6]int{s.X1, s.Y1, s.X2, s.Y2, s.X3, s.Y3}
					case *primitive.RotatedRectangle:
						st.Rect = &[5]int{s.X, s.Y, s.Sx, s.Sy, s.Angle}
					case *primitive.RotatedEllipse:
						st.Ell = &[5]string{fbits(s.X), fbits(s.Y), fbits(s.Rx), fbits(s.Ry), fbits(s.Angle)}
					}
					tc.Steps = append(tc.Steps, st)
				}
			}
			cases = append(cases, tc)
		}
	}

	f, err := os.Create("trace_golden.json")
	if err != nil {
		panic(err)
	}
	defer f.Close()
	if err := json.NewEncoder(f).Encode(cases); err != nil {
		panic(err)
	}
}
