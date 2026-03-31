const { Router } = require("express");
const { compareFacesController, compareFacesByAWSController, faceServiceHealthController } = require("../controllers/face.controller");

const router = Router();
router.post("/compare", compareFacesController);
router.post("/compare-aws", compareFacesByAWSController);
router.get("/health", faceServiceHealthController);
module.exports = router;
