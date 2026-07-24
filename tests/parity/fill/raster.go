package main

// raster: dumps the scanlines emitted by primitive.RotatedEllipse.Rasterize
// (which goes through the freetype rasterizer via fillPath) for many random
// ellipses across several image sizes, so goraster.js can be validated exactly.
//
// Output: tests/parity/fill/raster_golden.json (written directly; no BOM).

import (
	"encoding/json"
	"image"
	"math/rand"
	"os"

	"github.com/fogleman/primitive/primitive"
)

type rasterCase struct {
	W      int        `json:"w"`
	H      int        `json:"h"`
	Params [5]float64 `json:"params"` // X,Y,Rx,Ry,Angle
	Lines  [][4]int64 `json:"lines"`  // Y, X1, X2, Alpha
}

func runRaster() {
	sizes := [][2]int{{64, 48}, {160, 120}, {32, 32}, {200, 150}}
	r := rand.New(rand.NewSource(12345))
	cases := []rasterCase{}
	for _, sz := range sizes {
		w, h := sz[0], sz[1]
		target := image.NewRGBA(image.Rect(0, 0, w, h))
		worker := primitive.NewWorker(target)
		for k := 0; k < 200; k++ {
			// Mix of typical and edge-case ellipses.
			x := r.Float64() * float64(w)
			y := r.Float64() * float64(h)
			rx := r.Float64()*32 + 1
			ry := r.Float64()*32 + 1
			ang := r.Float64() * 360
			if k%17 == 0 { // occasionally push off-image / tiny / large
				x = r.Float64()*float64(w)*1.4 - float64(w)*0.2
				y = r.Float64()*float64(h)*1.4 - float64(h)*0.2
			}
			if k%23 == 0 {
				rx = r.Float64()*2 + 0.5
				ry = r.Float64()*2 + 0.5
			}
			if k%29 == 0 {
				rx = r.Float64()*80 + 30
				ry = r.Float64()*80 + 30
			}
			e := &primitive.RotatedEllipse{Worker: worker, X: x, Y: y, Rx: rx, Ry: ry, Angle: ang}
			lines := e.Rasterize()
			out := make([][4]int64, 0, len(lines))
			for _, ln := range lines {
				out = append(out, [4]int64{int64(ln.Y), int64(ln.X1), int64(ln.X2), int64(ln.Alpha)})
			}
			cases = append(cases, rasterCase{
				W: w, H: h, Params: [5]float64{x, y, rx, ry, ang}, Lines: out,
			})
		}
	}
	f, err := os.Create("raster_golden.json")
	if err != nil {
		panic(err)
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	if err := enc.Encode(cases); err != nil {
		panic(err)
	}
}
