const { Router } = require("express");
const { compareFacesController, compareFacesByAWSController, faceServiceHealthController, verifyIdentityController } = require("../controllers/face.controller");

const router = Router();
router.post("/compare", compareFacesController);
router.post("/compare-aws", compareFacesByAWSController);
router.post("/verify-identity", verifyIdentityController);
router.get("/health", faceServiceHealthController);
module.exports = router;
