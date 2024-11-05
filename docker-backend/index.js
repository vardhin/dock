const express = require("express");
const multer = require("multer");
const fs = require("fs");
const Docker = require("dockerode");
const docker = new Docker();
const upload = multer();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post("/run-code", upload.single("file"), async (req, res) => {
    let code = req.body.code;

    // Save the code to a temporary file if uploaded, otherwise from textarea
    const filePath = "/tmp/code.py";
    if (req.file) {
        fs.writeFileSync(filePath, req.file.buffer.toString());
    } else if (code) {
        fs.writeFileSync(filePath, code);
    } else {
        return res.status(400).send({ output: "No code provided" });
    }

    try {
        // Create a container with 4GB RAM and 4 CPU limit
        const container = await docker.createContainer({
            Image: "python:alpine",
            Cmd: ["python3", "/app/code.py"],
            AttachStdout: true,
            AttachStderr: true,
            HostConfig: {
                Memory: 4 * 1024 * 1024 * 1024, // 4GB RAM
                NanoCPUs: 4 * 1e9,              // 4 CPUs
                Binds: [`${filePath}:/app/code.py`],
            },
        });

        await container.start();
        const logs = await container.logs({ stdout: true, stderr: true, follow: true });
        let output = "";
        logs.on("data", data => (output += data.toString()));

        await container.wait();
        await container.remove();
        fs.unlinkSync(filePath); // Clean up temp file

        res.send({ output });
    } catch (error) {
        res.status(500).send({ output: error.message });
    }
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));
