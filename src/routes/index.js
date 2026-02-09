const express = require("express");
const devRoute = require("./health.route");
const otpRoute = require("./otp.route");
const managerRoute = require("./manager.route");
const faceRoute = require("./face.route");
const customerRoute = require("./customer.route");
const imageRoute = require("./image.route");
const callLogRoute = require("./callLog.route");
const cbsRoute = require("./cbs.route");
const nidRoute = require("./nid.route");
const feedbackRoute = require("./feedback.route");
const adminRoute = require("./admin.route");
const openviduRoute = require("./openvidu.route");
const recordingRoute = require("./recording.route");
const callReportRoute = require("./callReport.route");
const router = express.Router();
const defaultRoutes = [
  {
    path: "/dev",
    route: devRoute,
  },
  {
    path: "/otp",
    route: otpRoute,
  },
  {
    path: "/manager",
    route: managerRoute,
  },
  {
    path: "/face",
    route: faceRoute,
  },
  {
    path: "/customer",
    route: customerRoute,
  },
  {
    path: "/image",
    route: imageRoute,
  },
  {
    path: "/call-logs",
    route: callLogRoute,
  },
  {
    path: "/cbs",
    route: cbsRoute,
  },
  {
    path: "/nid",
    route: nidRoute,
  },
  {
    path: "/feedback",
    route: feedbackRoute,
  },
  {
    path: "/admin",
    route: adminRoute,
  },
  {
    path: "/openvidu",
    route: openviduRoute,
  },
  {
    path: "/recording",
    route: recordingRoute,
  },
  {
    path: "/call-reports",
    route: callReportRoute,
  },
];

defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});
module.exports = router;
