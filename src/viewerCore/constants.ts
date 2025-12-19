export const DEFAULT_USDA = `#usda 1.0
(
  defaultPrim = "World"
  upAxis = "Y"
  metersPerUnit = 0.01
)
def Xform "World" {
  def Sphere "Ball" {
    double radius = 10
    double3 xformOp:translate = (0, 10, 0)
  }
  def Mesh "Cube" {
    # minimal mesh-ish data; viewer currently uses points to compute bounds
    point3f[] points = [(-10,-10,-10), (10,-10,-10), (10,10,-10), (-10,10,-10), (-10,-10,10), (10,-10,10), (10,10,10), (-10,10,10)]
    double3 xformOp:translate = (30, 10, 0)
  }
}
`;


