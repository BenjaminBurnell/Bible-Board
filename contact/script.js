document.addEventListener("DOMContentLoaded", () => {
  const contactForm = document.getElementById("contactForm");
  const submitBtn = contactForm.querySelector(".submit-btn");
  const statusMsg = document.getElementById("form-status");

  if (contactForm) {
    contactForm.addEventListener("submit", async (e) => {
      e.preventDefault(); // Stop page reload

      // 1. Setup Form Data (Using the logic from your snippet)
      const formData = new FormData(contactForm);
      
      // Add your Access Key securely
      formData.append("access_key", "2193f2b0-3fae-439c-8bf7-8a2a1dd10496");

      // 2. Set Loading State (Visual feedback)
      submitBtn.classList.add("loading"); // Shows the spinner
      submitBtn.disabled = true;          // Prevents double-clicking
      statusMsg.textContent = "";         // Clear previous messages
      statusMsg.className = "form-status";

      try {
        // 3. Send Request (Using Web3Forms URL)
        const response = await fetch("https://api.web3forms.com/submit", {
          method: "POST",
          body: formData
        });

        const data = await response.json();

        // 4. Handle Response
        if (response.ok) {
          // Success
          statusMsg.textContent = "Success! Your message has been sent.";
          statusMsg.classList.add("success");
          contactForm.reset(); // Clear the form inputs
        } else {
          // Error from API
          console.error(data);
          statusMsg.textContent = data.message || "Something went wrong. Please try again.";
          statusMsg.classList.add("error");
        }

      } catch (error) {
        // Network Error
        console.error(error);
        statusMsg.textContent = "Connection error. Please try again.";
        statusMsg.classList.add("error");
      } finally {
        // 5. Reset Button State
        submitBtn.classList.remove("loading");
        submitBtn.disabled = false;
      }
    });
  }
});